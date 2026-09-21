export const AWAIT_CLICK_SCRIPT = `(async function() {
  // Why: hand the click result to executeJavaScript through a native (intrinsic)
  // Promise. On pages that replace the global Promise with a non-native thenable
  // — e.g. Angular Zone.js's ZoneAwarePromise — a bare \`new Promise(...)\` is not
  // recognized as a promise by Electron, so its raw wrapper object (exposing
  // __zone_symbol__state/__value instead of { page, target }) crosses the boundary
  // and main rejects it as an invalid payload structure. An async function's
  // promise comes from the engine intrinsic that page code cannot reassign, so
  // Electron always unwraps it to the resolved payload.
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
      // Why: freeze the highlight instead of removing it so the user sees
      // which element was selected while the copy menu is shown. Teardown
      // happens later when the renderer calls setGrabMode(false) or re-arms.
      grab.freezeHighlight();
      resolve(payload);
    }

    function onContext(e) {
      // Why: right-click resolves with the payload wrapped in a context-menu
      // marker so the renderer can show the full action dropdown instead of
      // auto-copying. This gives users a deliberate path to screenshot and
      // other secondary actions while keeping left-click as the fast copy path.
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
      grab.freezeHighlight();
      resolve({ __orcaContextMenu: true, payload: payload });
    }

    grab.host.addEventListener('click', onClick, true);
    grab.host.addEventListener('contextmenu', onContext, true);

    // Store cancel hook so teardown can settle the Promise
    grab.cancelAwait = function() {
      grab.host.removeEventListener('click', onClick, true);
      grab.host.removeEventListener('contextmenu', onContext, true);
      grab.cleanup();
      // Why: teardown cancellation is a normal user flow; resolving a marker
      // avoids a noisy guest-console Error while main still treats it as cancel.
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

// extractHover: read payload but keep overlay/listeners active so the user can keep picking (C/S shortcut copy, no click).
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
  // If there's an active awaitClick Promise, cancel it: cancelAwait resolves
  // it with the __orcaCancelled marker so the executeJavaScript call in main
  // settles the grab op as a cancellation.
  if (grab.cancelAwait) {
    grab.cancelAwait();
  } else {
    grab.cleanup();
  }
  return true;
})()`
