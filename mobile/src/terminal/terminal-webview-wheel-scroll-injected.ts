// Indirect-pointer (external mouse / trackpad) scroll for the terminal surface,
// injected into XTERM_HTML. Extracted from terminal-webview-html.ts to keep that
// file within its max-lines budget. Closes over host-IIFE state/functions:
// term, getCellHeight, getTotalScale, shouldRouteScrollToTerminalInput,
// routeScrollLines, enqueueNormalBufferScrollDelta, resetSmoothScrollOffset,
// and dispatcherShouldBlockSurface.
export const TERMINAL_WHEEL_SCROLL_JS = `
  var wheelAccumDeltaY = 0;

  function wheelEventPixelDeltaY(e) {
    var delta = e.deltaY;
    if (typeof delta !== 'number' || !isFinite(delta) || delta === 0) return 0;
    // DOM_DELTA_LINE / DOM_DELTA_PAGE: Android WebView reports line-mode deltas
    // for external mouse wheels, iOS trackpads report pixels.
    if (e.deltaMode === 1) return delta * getCellHeight() * getTotalScale();
    if (e.deltaMode === 2) return delta * window.innerHeight;
    return delta;
  }

  function attachSurfaceWheelHandler(targetSurface) {
    targetSurface.addEventListener('wheel', function(e) {
      if (dispatcherShouldBlockSurface()) return;
      if (!term) return;
      // Why: xterm's own wheel handler scrolls its hidden viewport or emits
      // cursor keys through onData, which the mobile query-reply gate drops.
      // Claim the event so indirect pointers share the touch scroll router.
      e.preventDefault();
      e.stopPropagation();

      // Why: a trackpad pinch arrives as ctrl+wheel. Swallow it rather than
      // firing cursor keys at the TUI; two-finger pinch still drives text size.
      if (e.ctrlKey) return;

      var deltaY = wheelEventPixelDeltaY(e);
      if (deltaY === 0) return;

      if (shouldRouteScrollToTerminalInput()) {
        resetSmoothScrollOffset();
        var effectiveCellH = getCellHeight() * getTotalScale();
        if (!(effectiveCellH > 0)) return;
        wheelAccumDeltaY += deltaY;
        var lines = Math.trunc(wheelAccumDeltaY / effectiveCellH);
        if (lines !== 0) {
          wheelAccumDeltaY -= lines * effectiveCellH;
          routeScrollLines(lines, e.clientX, e.clientY);
        }
        return;
      }
      wheelAccumDeltaY = 0;
      enqueueNormalBufferScrollDelta(deltaY);
    }, { capture: true, passive: false });
  }
`
