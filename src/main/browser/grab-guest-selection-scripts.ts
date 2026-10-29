export const AWAIT_CLICK_SCRIPT = `(async function() {
  // Async returns an intrinsic Promise Electron unwraps even when Zone.js replaces global Promise.
  return await new Promise(function(resolve, reject) {
    'use strict';
    var grab = window.__orcaGrab;
    if (!grab) {
      reject(new Error('Grab not armed'));
      return;
    }

    function extractSelectedPayload(el) {
      try {
        return grab.extractPayload(el);
      } catch (error) {
        grab.cleanup();
        reject(error instanceof Error ? error : new Error('Failed to extract element context'));
        return null;
      }
    }

    function onClick(e) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      grab.host.removeEventListener('click', onClick, true);
      grab.host.removeEventListener('contextmenu', onContext, true);
      var el = grab.getCurrentElement();
      if (!el) {
        grab.cleanup();
        reject(new Error('cancelled'));
        return;
      }
      var payload = extractSelectedPayload(el);
      if (!payload) return;
      // Keep the selected element outlined while the renderer shows its copy menu.
      grab.freezeHighlight(payload.page.capturedAt);
      resolve(payload);
    }

    function onContext(e) {
      // The marker opens the action menu instead of auto-copying.
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      grab.host.removeEventListener('click', onClick, true);
      grab.host.removeEventListener('contextmenu', onContext, true);
      var el = grab.getCurrentElement();
      if (!el) {
        grab.cleanup();
        reject(new Error('cancelled'));
        return;
      }
      var payload = extractSelectedPayload(el);
      if (!payload) return;
      grab.freezeHighlight(payload.page.capturedAt);
      resolve({ __orcaContextMenu: true, payload: payload });
    }

    grab.host.addEventListener('click', onClick, true);
    grab.host.addEventListener('contextmenu', onContext, true);

    grab.cancelAwait = function() {
      grab.host.removeEventListener('click', onClick, true);
      grab.host.removeEventListener('contextmenu', onContext, true);
      grab.cleanup();
      // Resolve cancellation to avoid guest-console errors during normal teardown.
      resolve({ __orcaCancelled: true });
    };
  });
})()`

export const FINALIZE_SCRIPT = `(function() {
  'use strict';
  var grab = window.__orcaGrab;
  if (!grab) return null;
  var el = grab.getCurrentElement();
  if (!el) return null;
  var payload = null;
  try {
    payload = grab.extractPayload(el);
  } catch (e) {
    grab.cleanup();
    return null;
  }
  grab.cleanup();
  return payload;
})()`

// Extract without ending grab mode, so shortcut copy can keep selecting.
export const EXTRACT_HOVER_SCRIPT = `(function() {
  'use strict';
  var grab = window.__orcaGrab;
  if (!grab) return null;
  var el = grab.getCurrentElement();
  if (!el) return null;
  try {
    return grab.extractPayload(el);
  } catch (e) {
    return null;
  }
})()`

export const TEARDOWN_SCRIPT = `(function() {
  'use strict';
  var grab = window.__orcaGrab;
  if (!grab) return true;
  // Settle the outstanding executeJavaScript call before removing grab state.
  if (grab.cancelAwait) {
    grab.cancelAwait();
  } else {
    grab.cleanup();
  }
  return true;
})()`
