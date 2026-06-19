// Document-level latching touch dispatcher, injected into XTERM_HTML. Extracted
// from terminal-webview-html.ts to keep that file within its max-lines budget.
// Closes over host-IIFE state/functions: dispatch/tapCandidate/longPress*,
// viewportToCell, enterSelect, cancelSelect, handleDragMove, stopEdgeScroll,
// notify, notifyTerminalSurfaceTap, surface/handle/overlay elements, sel/selMode,
// and the LONG_PRESS_*/TAP_* constants.
export const TERMINAL_TAP_DISPATCH_JS = `
  // ============================================================
  // LATCHING TOUCH DISPATCHER (document-level)
  // ============================================================
  var dispatch = { mode: 'idle', touchId: null, touchIds: null, longPressFingerInsideOverlay: false };

  function touchById(touches, id) {
    for (var i = 0; i < touches.length; i++) {
      if (touches[i].identifier === id) return touches[i];
    }
    return null;
  }

  function targetInside(target, el) {
    if (!target || !el) return false;
    return el.contains(target);
  }

  function clearLongPress() {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    longPressOrigin = null;
  }

  function armLongPress(touch) {
    longPressOrigin = { x: touch.clientX, y: touch.clientY, identifier: touch.identifier };
    longPressTimer = setTimeout(function() {
      longPressTimer = null;
      if (!longPressOrigin) return;
      var c = viewportToCell(longPressOrigin.x, longPressOrigin.y);
      if (!c) return;
      enterSelect(c.col, c.row);
    }, LONG_PRESS_MS);
  }

  function touchSlopExceeded(t) {
    if (!longPressOrigin) return false;
    var dx = Math.abs(t.clientX - longPressOrigin.x);
    var dy = Math.abs(t.clientY - longPressOrigin.y);
    return (dx + dy) > LONG_PRESS_SLOP;
  }

  // Why: existing surface handlers stay attached to surface but we wrap
  // their entry to no-op when the dispatcher latches into select-drag.
  function dispatcherShouldBlockSurface() {
    return dispatch.mode === 'select-drag';
  }

  document.addEventListener('touchstart', function(e) {
    var t = e.touches[0];
    var target = e.target;
    var onHandle = target === handleStart || target === handleEnd;
    var inOverlay = targetInside(target, selectionOverlay);
    var inSurface = targetInside(target, surface);
    // Why: clear any stale tap candidate up front; only a fresh single-finger
    // surface touch (below) re-arms it, so handle drags / pinches / dismiss
    // taps never resolve as a link tap on touchend.
    tapCandidate = null;

    if (e.touches.length === 2) {
      // pinch latch
      if (selMode === 'select') {
        notify({ type: 'mobile-clip-cancel-by-pinch' });
        cancelSelect();
      }
      dispatch.mode = 'pinch';
      dispatch.touchIds = [e.touches[0].identifier, e.touches[1].identifier];
      clearLongPress();
      return;
    }

    if (onHandle && selMode === 'select') {
      // start handle drag
      var handleName = (target === handleStart) ? 'start' : 'end';
      sel.activeHandle = handleName;
      dispatch.mode = 'select-drag';
      dispatch.touchId = t.identifier;
      e.preventDefault();
      return;
    }

    if (inOverlay) {
      // tap on menu pill — let the buttons' own handlers fire
      return;
    }

    if (inSurface && selMode === 'select') {
      // Why: tap-to-dismiss matches native iOS/Android — touching outside the
      // selection clears it. We cancel immediately and latch to 'surface' so
      // the same gesture still drives scroll/pan without a second touch.
      cancelSelect();
      dispatch.mode = 'surface';
      dispatch.touchId = t.identifier;
      return;
    }

    if (inSurface) {
      dispatch.mode = 'surface';
      dispatch.touchId = t.identifier;
      tapCandidate = { x: t.clientX, y: t.clientY, t: Date.now(), identifier: t.identifier };
      armLongPress(t);
    }
  }, { capture: true, passive: false });

  document.addEventListener('touchmove', function(e) {
    if (dispatch.mode === 'select-drag') {
      var t = touchById(e.touches, dispatch.touchId);
      if (!t || !sel || !sel.activeHandle) return;
      e.preventDefault();
      handleDragMove(sel.activeHandle, t.clientX, t.clientY);
      return;
    }
    if (dispatch.mode === 'surface' || dispatch.mode === 'pinch') {
      // long-press slop check
      if (longPressTimer && e.touches.length === 1) {
        if (touchSlopExceeded(e.touches[0])) clearLongPress();
      }
      // Why: disqualify the tap only once the finger travels past TAP_SLOP
      // (a scroll/pan), independent of the long-press timer — so a tap that
      // jitters under TAP_SLOP still opens the link/path under the finger.
      if (tapCandidate && e.touches.length === 1) {
        var mt = e.touches[0];
        if (mt.identifier === tapCandidate.identifier) {
          var dx = Math.abs(mt.clientX - tapCandidate.x);
          var dy = Math.abs(mt.clientY - tapCandidate.y);
          if (dx + dy > TAP_SLOP) tapCandidate = null;
        }
      } else if (e.touches.length !== 1) {
        tapCandidate = null;
      }
      // existing surface handler will run from its own listener
    }
  }, { capture: true, passive: false });

  document.addEventListener('touchend', function(e) {
    if (dispatch.mode === 'select-drag') {
      if (sel) sel.activeHandle = null;
      stopEdgeScroll();
      dispatch.mode = 'idle';
      dispatch.touchId = null;
      return;
    }
    if (dispatch.mode === 'pinch') {
      if (e.touches.length < 2) {
        dispatch.mode = (e.touches.length === 1) ? 'surface' : 'idle';
        dispatch.touchIds = null;
        if (e.touches.length === 1) dispatch.touchId = e.touches[0].identifier;
      }
      return;
    }
    if (dispatch.mode === 'surface') {
      // Why: fire the tap from the tap-candidate origin (survives jitter under
      // TAP_SLOP) rather than longPressOrigin, which the press-to-select slop
      // can null mid-tap — that was dropping URL/file taps that moved a few px.
      if (
        e.touches.length === 0 &&
        tapCandidate &&
        selMode !== 'select' &&
        Date.now() - tapCandidate.t <= TAP_MAX_MS
      ) {
        notifyTerminalSurfaceTap(tapCandidate.x, tapCandidate.y);
      }
      clearLongPress();
      tapCandidate = null;
      if (e.touches.length === 0) {
        dispatch.mode = 'idle';
        dispatch.touchId = null;
      }
    }
  }, { capture: true, passive: true });

  document.addEventListener('touchcancel', function() {
    clearLongPress();
    tapCandidate = null;
    stopEdgeScroll();
    if (dispatch.mode === 'select-drag') {
      if (sel) sel.activeHandle = null;
    }
    dispatch.mode = 'idle';
    dispatch.touchId = null;
    dispatch.touchIds = null;
  }, { capture: true, passive: true });
`
