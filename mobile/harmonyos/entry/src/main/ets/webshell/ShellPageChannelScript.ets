// Page channel shim: window.orcaBridge (postMessage + assignable onmessage) over the
// orcaNative proxy, mirroring orca-bridge-page-channel.ts's exact surface.
export const SHELL_PAGE_CHANNEL_SCRIPT = `
(function () {
  'use strict';
  var native = window.orcaNative;
  if (!native || typeof native.postMessage !== 'function') {
    window.__orcaShellError = 'orcaNative proxy missing';
    return;
  }
  var queued = [];
  var handler = null;
  var bridge = {
    postMessage: function (json) {
      var text = String(json);
      if (text.includes('"navigate-back"') && native.isWorkspaceDrawer()) {
        var frame;
        try { frame = JSON.parse(text); } catch (e) { /* native validates invalid frames */ }
        // Older pages post Back just before the created session route in the same turn.
        if (frame && frame.type === 'notify' && frame.name === 'navigate-back') {
          queueMicrotask(function () { native.postMessage(text); });
          return;
        }
      }
      native.postMessage(text);
    },
  };
  Object.defineProperty(bridge, 'onmessage', {
    set: function (fn) {
      handler = fn;
      try { native.notifyOnMessageSet(); } catch (e) { /* proxy not callable yet */ }
      while (queued.length > 0) {
        var f = queued.shift();
        try { fn({ data: f }); } catch (e) { /* handler error surfaces via page console */ }
      }
    },
    get: function () { return handler; },
    configurable: true
  });
  window.orcaBridge = bridge;
  ['warn', 'error'].forEach(function (level) {
    var orig = console[level].bind(console);
    console[level] = function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        try {
          var a = arguments[i];
          parts.push(typeof a === 'string' ? a : JSON.stringify(a));
        } catch (e) { parts.push('[unserializable]'); }
      }
      try {
        native.postMessage(JSON.stringify({ v: 1, type: 'page.console', level: level, text: parts.join(' ').slice(0, 400) }));
      } catch (e2) { /* drop */ }
      orig.apply(null, arguments);
    };
  });
  window.__orcaNativePush = function (json, enqueue) {
    if (handler) {
      try { handler({ data: json }); return 'delivered'; }
      catch (e) { return 'error: ' + (e && e.message || String(e)); }
    }
    if (enqueue === false) { return 'unavailable'; }
    queued.push(json);
    return 'queued';
  };
})();
`;
