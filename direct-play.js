(function () {
    'use strict';

    /**
     * Direct Play for Lampa
     * 1. Кнопка «Смотреть» сразу открывает источник, если он единственный,
     *    вместо меню выбора источника с одним пунктом.
     * 2. Кнопка «Смотреть» продолжает просмотр: тот же торрент, та же серия
     *    (или следующая, если текущая досмотрена). Долгое нажатие — обычный выбор.
     */
    var VERSION = '1.1.0';
    var LOG = '[Direct-Play]';
    var DEBUG_KEY = 'direct_play_debug';
    var RESUME_KEY = 'direct_play_resume';
    var SOURCE_TITLE_KEY = 'settings_rest_source';
    var RESUME_LIMIT = 100;
    var WATCHED_PERCENT = 90;
    var PENDING_TTL_MS = 120000;
    var BYPASS_MS = 1500;
    // Lampa рендерит список файлов синхронно и сразу обновляет модалку: даём ей дорисоваться.
    var RENDER_SETTLE_MS = 300;

    var resume = {
        lastStart: null,
        pending: null,
        renderTimer: null,
        bypassUntil: 0
    };

    function debug() {
        try {
            var v = Lampa.Storage.get(DEBUG_KEY, false);
            return v === true || v === 'true';
        } catch (e) {
            return false;
        }
    }

    function log() {
        if (!debug()) return;
        try {
            var args = Array.prototype.slice.call(arguments);
            args.unshift(LOG);
            console.log.apply(console, args);
        } catch (e) {}
    }

    function safe(fn) {
        return function () {
            try {
                return fn.apply(this, arguments);
            } catch (e) {
                log('error', e && e.message ? e.message : e);
            }
        };
    }

    function notify(text) {
        try {
            if (Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show(text);
        } catch (e) {}
    }

    /* ---------- Меню источников ---------- */

    function sourceMenuTitle() {
        try {
            return Lampa.Lang.translate(SOURCE_TITLE_KEY);
        } catch (e) {
            return '';
        }
    }

    // Меню источников карточки: заголовок «Источник», у пунктов есть кнопка карточки (btn).
    function cardSources(params) {
        if (!params || !params.items || typeof params.onSelect !== 'function') return null;
        if (params.title !== sourceMenuTitle()) return null;

        var sources = params.items.filter(function (item) {
            return item && !item.add_source;
        });

        for (var i = 0; i < sources.length; i++) {
            if (!sources[i].btn) return null;
        }
        return sources;
    }

    function hasTorrentSource(sources) {
        for (var i = 0; i < sources.length; i++) {
            if (sources[i].btn.hasClass && sources[i].btn.hasClass('view--torrent')) return true;
        }
        return false;
    }

    /* ---------- Запоминание просмотра ---------- */

    function cardKey(card) {
        if (!card || card.id === undefined || card.id === null) return '';
        return (card.name || card.original_name ? 'tv_' : 'movie_') + card.id;
    }

    function activeCard() {
        try {
            var activity = Lampa.Activity.active();
            return activity ? (activity.card || activity.movie || null) : null;
        } catch (e) {
            return null;
        }
    }

    function loadRecords() {
        try {
            var records = Lampa.Storage.get(RESUME_KEY, {});
            return records && typeof records === 'object' ? records : {};
        } catch (e) {
            return {};
        }
    }

    function saveRecord(key, record) {
        var records = loadRecords();
        record.updated = Date.now();
        records[key] = record;

        var keys = Object.keys(records);
        if (keys.length > RESUME_LIMIT) {
            keys.sort(function (a, b) {
                return (records[a].updated || 0) - (records[b].updated || 0);
            });
            keys.slice(0, keys.length - RESUME_LIMIT).forEach(function (k) {
                delete records[k];
            });
        }

        Lampa.Storage.set(RESUME_KEY, records);
    }

    function pickTorrent(object) {
        if (!object || !(object.MagnetUri || object.Link)) return null;

        return {
            title: object.title || '',
            MagnetUri: object.MagnetUri || '',
            Link: object.Link || '',
            poster: object.poster || ''
        };
    }

    function rememberPlayback(file, card) {
        var key = cardKey(card);
        if (!key || !file || !file.torrent_hash || file.id === undefined) return;

        var previous = loadRecords()[key];
        var torrent = resume.lastStart && resume.lastStart.key === key ? resume.lastStart.torrent : null;

        if (!torrent && previous && previous.hash === file.torrent_hash) torrent = previous.torrent;

        saveRecord(key, {
            hash: file.torrent_hash,
            fileId: file.id,
            title: file.title || '',
            torrent: torrent || null
        });

        log('remember', key, file.torrent_hash, file.id);
    }

    function patchTorrent() {
        var originalStart = Lampa.Torrent.start;
        var originalOpen = Lampa.Torrent.open;

        Lampa.Torrent.start = function (element, movie) {
            resume.lastStart = { key: cardKey(movie), torrent: pickTorrent(element) };
            return originalStart.apply(this, arguments);
        };

        Lampa.Torrent.open = function (hash, movie) {
            resume.lastStart = { key: cardKey(movie), torrent: null };
            return originalOpen.apply(this, arguments);
        };
    }

    /* ---------- Продолжение просмотра ---------- */

    function startResume(card, record) {
        resume.pending = {
            key: cardKey(card),
            fileId: record.fileId,
            expires: Date.now() + PENDING_TTL_MS,
            order: null,
            rendered: {}
        };

        log('resume', record.hash, record.fileId);
        notify('Продолжение просмотра' + (record.title ? ': ' + record.title : ''));

        if (record.torrent) Lampa.Torrent.start(record.torrent, card);
        else Lampa.Torrent.open(record.hash, card);
    }

    function playPending() {
        var pending = resume.pending;
        resume.pending = null;
        if (!pending || !pending.order) return;

        var index = -1;
        for (var i = 0; i < pending.order.length; i++) {
            if (String(pending.order[i].id) === String(pending.fileId)) {
                index = i;
                break;
            }
        }

        // Файла нет в раздаче: оставляем список, пусть пользователь выберет сам.
        if (index < 0) return;

        var timeline = pending.order[index].timeline || {};
        if (timeline.percent >= WATCHED_PERCENT && index + 1 < pending.order.length) index += 1;

        var item = pending.rendered[pending.order[index].id];
        if (item) item.trigger('hover:enter');
    }

    function onTorrentFile(e) {
        if (!e) return;

        if (e.type === 'onenter') {
            rememberPlayback(e.element, e.params && e.params.movie);
            return;
        }

        if (e.type === 'list_close') {
            resume.pending = null;
            return;
        }

        if (e.type !== 'render' || !resume.pending) return;

        var pending = resume.pending;
        if (Date.now() > pending.expires || cardKey(e.params && e.params.movie) !== pending.key) {
            resume.pending = null;
            return;
        }

        pending.order = e.items;
        pending.rendered[e.element.id] = e.item;

        clearTimeout(resume.renderTimer);
        resume.renderTimer = setTimeout(safe(playPending), RENDER_SETTLE_MS);
    }

    function onPlayerClose(e) {
        var data = e && e.data;
        if (data && data.torrent_hash) rememberPlayback(data, data.card);
    }

    function bindLongPress() {
        var $ = window.jQuery || window.$;
        if (!$) return;

        $(document).on('hover:long', '.button--play', function () {
            resume.bypassUntil = Date.now() + BYPASS_MS;
            $(this).trigger('hover:enter');
        });
    }

    /* ---------- Перехват меню ---------- */

    function handleSourceMenu(params) {
        var sources = cardSources(params);
        if (!sources) return false;

        if (Date.now() > resume.bypassUntil && hasTorrentSource(sources)) {
            var card = activeCard();
            var record = loadRecords()[cardKey(card)];

            if (record && record.hash) {
                startResume(card, record);
                return true;
            }
        }

        if (sources.length !== 1) return false;

        log('open', sources[0].title);
        params.onSelect(sources[0]);
        return true;
    }

    function patchSelect() {
        var originalShow = Lampa.Select.show;

        Lampa.Select.show = function (params) {
            var handled = false;

            try {
                handled = handleSourceMenu(params);
            } catch (e) {
                log('error', e && e.message ? e.message : e);
            }

            if (!handled) return originalShow.apply(this, arguments);
        };
    }

    function bind() {
        var ready = window.Lampa && Lampa.Select && typeof Lampa.Select.show === 'function'
            && Lampa.Lang && Lampa.Torrent && Lampa.Listener && Lampa.Player && Lampa.Player.listener;

        if (!ready) {
            setTimeout(bind, 500);
            return;
        }

        patchSelect();
        patchTorrent();
        Lampa.Listener.follow('torrent_file', safe(onTorrentFile));
        Lampa.Player.listener.follow('close', safe(onPlayerClose));
        bindLongPress();

        try {
            console.log(LOG, 'v' + VERSION);
        } catch (e) {}
    }

    if (!window.direct_play_loaded) {
        window.direct_play_loaded = true;
        bind();
    }
})();
