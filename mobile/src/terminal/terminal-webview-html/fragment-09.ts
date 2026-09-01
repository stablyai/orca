import { TERMINAL_TAP_DISPATCH_JS } from '../terminal-webview-tap-dispatch-injected'
import { TERMINAL_WHEEL_SCROLL_JS } from '../terminal-webview-wheel-scroll-injected'
import { TERMINAL_MOUSE_CLICK_DRAG_JS } from '../terminal-webview-mouse-click-drag-injected'

export const TERMINAL_HTML_FRAGMENT_09 = `  ${TERMINAL_TAP_DISPATCH_JS}

  // External mouse / trackpad scroll: see
  // terminal-webview-wheel-scroll-injected.ts (extracted for max-lines).
  ${TERMINAL_WHEEL_SCROLL_JS}

  // External mouse click/drag: see
  // terminal-webview-mouse-click-drag-injected.ts (extracted for max-lines).
  ${TERMINAL_MOUSE_CLICK_DRAG_JS}

  btnCopy.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!term) return;
    var text = term.getSelection ? term.getSelection() : '';
    if (text && text.length > 0) {
      notify({ type: 'selection', text: text });
    } else {
      cancelSelect();
    }
  });

  btnSelAll.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!term) return;
    try {
      term.selectAll();
      var b = term.buffer.active;
      sel = {
        anchor: { col: 0, row: 0 },
        focus: { col: term.cols - 1, row: b.length - 1 },
        activeHandle: null
      };
      repositionOverlay();
    } catch (err) {}
  });

  var ts = {
    lastX: 0, lastY: 0, lastTime: 0, velY: 0,
    accumDelta: 0, momentumId: null, isPinching: false,
    pinchDist: 0, pinchScale: 0, pinchSurfX: 0, pinchSurfY: 0
  };

  function updateTouchVelocity(deltaY, dt) {
    if (dt <= 0) return;
    var instantVelocity = deltaY / dt;
    if (!isFinite(instantVelocity)) return;
    // Why: touchmove cadence is uneven in WebView. Blend recent samples so
    // momentum launch doesn't inherit a one-frame spike or stall.
    ts.velY = ts.velY === 0 ? instantVelocity : ts.velY * 0.55 + instantVelocity * 0.45;
  }

  function getDistance(a, b) {
    var dx = a.clientX - b.clientX, dy = a.clientY - b.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function attachSurfaceEventHandlers(targetSurface) {
    if (!targetSurface || targetSurface.__orcaSurfaceHandlersAttached) return;
    targetSurface.__orcaSurfaceHandlersAttached = true;
    // Why: init() swaps in a new hidden surface to avoid flicker; each
    // replacement needs gesture handlers or tab-switch replays stop scrolling.
    targetSurface.addEventListener('mousedown', function(e) { e.preventDefault(); e.stopPropagation(); }, true);
    targetSurface.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); }, true);

    attachSurfaceWheelHandler(targetSurface);
    attachSurfaceMouseClickDragHandler(targetSurface);

    targetSurface.addEventListener('touchstart', function(e) {
      if (dispatcherShouldBlockSurface()) return;
      if (ts.momentumId) {
        cancelAnimationFrame(ts.momentumId);
        ts.momentumId = null;
      }
      if (e.touches.length === 2) {
        ts.isPinching = true;
        smoothScrollOffsetY = 0;
        ts.pinchDist = getDistance(e.touches[0], e.touches[1]);
        ts.pinchScale = userScale;
        var mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        var my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        var total = getTotalScale();
        ts.pinchSurfX = (mx - panX) / total;
        ts.pinchSurfY = (my - panY) / total;
      } else if (e.touches.length === 1) {
        ts.isPinching = false;
        ts.lastX = e.touches[0].clientX;
        ts.lastY = e.touches[0].clientY;
        ts.lastTime = Date.now();
        ts.velY = 0;
        ts.accumDelta = 0;
      }
    }, { capture: true, passive: true });

    targetSurface.addEventListener('touchmove', function(e) {
      if (dispatcherShouldBlockSurface()) return;
      if (!term) return;
      e.preventDefault();
      e.stopPropagation();

      if (e.touches.length === 2) {
        ts.isPinching = true;
        var dist = getDistance(e.touches[0], e.touches[1]);
        var mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        var my = (e.touches[0].clientY + e.touches[1].clientY) / 2;

        var ratio = dist / ts.pinchDist;
        // Why: userScale is a CSS multiplier on the current font size; bound it so
        // the resulting apparent size (currentTextScale × userScale) stays within
        // the preset range, since release snaps to one of those presets.
        var loScale = MIN_TEXT_SCALE / currentTextScale;
        var hiScale = MAX_TEXT_SCALE / currentTextScale;
        userScale = Math.max(loScale, Math.min(hiScale, ts.pinchScale * ratio));

        var total = getTotalScale();
        panX = mx - ts.pinchSurfX * total;
        panY = my - ts.pinchSurfY * total;
        clampPan();
        updateTransform();

      } else if (e.touches.length === 1 && !ts.isPinching) {
        var x = e.touches[0].clientX, y = e.touches[0].clientY;
        var now = Date.now(), dt = now - ts.lastTime;

        // Why: pan horizontally only when content overflows the viewport (larger
        // than fit) — same check clampPan() uses. Vertical always drives buffer
        // scroll so scrollback stays reachable at any text size; calling the
        // never-defined contentWiderThanViewport() here threw and killed all
        // single-finger scrolling, scrollback included.
        if (term.element && term.element.scrollWidth * getTotalScale() > window.innerWidth + 1) {
          panX += x - ts.lastX;
          clampPan();
`
