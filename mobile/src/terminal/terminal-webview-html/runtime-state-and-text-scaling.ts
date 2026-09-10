import { TERMINAL_QUERY_REPLY_JS } from '../terminal-webview-query-reply-injected'
import { TERMINAL_SURFACE_SWAP_JS } from '../terminal-webview-surface-swap-injected'
import { TERMINAL_TEXT_SCALES } from '../../storage/preferences'
import { DEFAULT_TERMINAL_THEME } from './theme'

// Also carries the scroll-indicator painter, which reads the scale state declared here.
export const TERMINAL_HTML_RUNTIME_STATE_AND_TEXT_SCALING = `  var PRIVATE_MODE_SCAN_TAIL_LIMIT = 4096;
  var term = null; ${TERMINAL_QUERY_REPLY_JS}
  ${TERMINAL_SURFACE_SWAP_JS}
  var scrollIndicator = document.getElementById('scroll-indicator');
  var scrollThumb = document.getElementById('scroll-thumb');
  var scrollIndicatorHideTimer = null;
  var writeQueue = [];
  var writeQueueHead = 0;
  var writesDraining = false;
  var afterDrainCallbacks = [];
  var termObserverDisposables = [];
  var ready = false;
  // Why: init() flips ready false on every re-init (live width reflow included)
  // while the old surface stays visible; a document-scoped latch drives the
  // fatal/non-fatal decision so a transient reflow cannot blank a live terminal.
  var everReady = false;
  var currentScale = 1;
  // Why: userScale is transient pinch zoom (CSS) for smooth feedback DURING a
  // gesture only; it resets to 1 on release. The persistent "text size" is the
  // real xterm fontSize (currentTextScale × BASE_FONT_PX), so changing it
  // reflows the grid: a bigger cell means fewer columns fit, and RN re-measures
  // and resizes the PTY (terminal.updateViewport) so the shell rewraps to the
  // new width. A finished pinch snaps to the nearest preset and reports it to RN.
  var userScale = 1;
  var BASE_FONT_PX = 13;
  var MIN_FONT_PX = 6;
  var MIN_FIT_COLS = 20;
  var currentTextScale = 1;
  var TEXT_SCALE_PRESETS = ${JSON.stringify([...TERMINAL_TEXT_SCALES])};
  var MIN_TEXT_SCALE = TEXT_SCALE_PRESETS[0];
  var MAX_TEXT_SCALE = TEXT_SCALE_PRESETS[TEXT_SCALE_PRESETS.length - 1];
  function snapToTextScalePreset(value) {
    var best = TEXT_SCALE_PRESETS[0], bestDelta = Infinity;
    for (var i = 0; i < TEXT_SCALE_PRESETS.length; i++) {
      var delta = Math.abs(TEXT_SCALE_PRESETS[i] - value);
      if (delta < bestDelta) { bestDelta = delta; best = TEXT_SCALE_PRESETS[i]; }
    }
    return best;
  }
  function fontPxForScale(scale) {
    return Math.max(MIN_FONT_PX, Math.round(BASE_FONT_PX * scale));
  }
  function isIOSWebView() {
    if (/iP(ad|hone|od)/.test(navigator.userAgent)) return true;
    return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  }
  // Why: iOS WebKit does not reliably resolve "SF Mono" by CSS family name and can
  // fall to a non-monospace face; lead with the ui-monospace generic to avoid that.
  var TERMINAL_FONT_FALLBACKS = '"Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Symbols Nerd Font Mono", monospace';
  var terminalFontFamily = (isIOSWebView() ? 'ui-monospace, ' : '"SF Mono", ') + TERMINAL_FONT_FALLBACKS;
  // Why: change the real font size, then resize the grid to fit the viewport at
  // the new cell metrics so the text shows at its true size immediately. RN's
  // refit (measure → updateViewport) then makes the server reflow the PTY to the
  // same column count so the shell rewraps. cell metrics update on the frame
  // after fontSize changes, so the resize/fit is deferred one rAF.
  function applyTextScale(scale) {
    currentTextScale = scale;
    if (!term) return;
    var px = fontPxForScale(scale);
    if (term.options.fontSize === px) return;
    term.options.fontSize = px;
    requestAnimationFrame(function() {
      if (!term) return;
      var cellW = getCellWidth();
      var cellH = getCellHeight();
      if (cellW > 0 && cellH > 0) {
        var cols = Math.floor(window.innerWidth / cellW);
        if (cols < MIN_FIT_COLS) return;
        var rows = Math.max(8, Math.floor(window.innerHeight / cellH));
        term.resize(cols, rows);
        emitKeyboardAvoidanceMetrics();
      }
      applyFitScale('text-scale');
    });
  }
  var panX = 0, panY = 0;
  var smoothScrollOffsetY = 0;
  var pendingNormalScrollDeltaY = 0;
  var normalScrollFrameId = null;
  var initRows = 24;
  var terminalGeneration = 0;
  var defaultTheme = ${JSON.stringify(DEFAULT_TERMINAL_THEME)};
  var terminalThemeInput = null;
  var terminalTheme = defaultTheme;
  var terminalMinimumContrastRatio = 3;
  var webglAddon = null;
  var webglRecoveryTimer = null;
  var activeAltScreenSnapshot = false;
  var trackedMouseTrackingMode = 'none';
  var sgrMouseMode = false;
  var sgrMousePixelsMode = false;
  var initialOscLinks = [], initialOscLinkRowOffset = 0;
  var initialOscLinkEvictionReady = false;
  var mouseModeScanTail = '';
  var handledMessageIds = [];
  // Why: after init() the initial scrollback applyFitScale may have run
  // against an empty buffer (or one without the widest line yet). Re-fit
  // once when the first live data chunk arrives so a wider line that pushes
  // scrollWidth past the previously-measured value gets re-scaled to fit.
  var firstDataPending = false;

  // Diagnostic logger — bridges WebView console.log to RN via postMessage.
  // Tag with [fit] so it's easy to filter in the Expo/Metro logs.
  function flog(tag, payload) {
    try {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'log', tag: '[fit]' + tag, payload: payload
        }));
      }
    } catch (e) {}
  }

  function getCellWidth() {
    if (!term || !term._core) return 0;
    var core = term._core;
    if (core._renderService && core._renderService.dimensions) {
      return core._renderService.dimensions.css.cell.width || 0;
    }
    return 0;
  }

  // Why: width measurement strategy.
  //   1. Prefer cellWidth × term.cols — this is what xterm's renderer uses
  //      to lay out and is independent of buffer content. It's the "logical
  //      width" of the terminal grid.
  //   2. Fall back to term.element.scrollWidth — the actual rendered DOM
  //      width — only when cellWidth isn't available yet (renderer not
  //      initialized). This is content-dependent (reflects widest row),
  //      but better than nothing.
  //   3. If both are 0, return 1 (no scale change). The retry loop in
  //      applyFitScale will keep trying until one is positive.
  function computeFitScale() {
    if (!term) return 1;
    var cellW = getCellWidth();
    var termWidth = cellW > 0 ? cellW * term.cols : (term.element ? term.element.scrollWidth : 0);
    if (termWidth <= 0) return 1;
    var vpWidth = window.innerWidth;
    return Math.min(1, vpWidth / termWidth);
  }

  function getTotalScale() { return currentScale * userScale; }

  function updateTransform() {
    surface.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + getTotalScale() + ')';
    updateScrollIndicator(false);
    if (selMode === 'select') repositionOverlay();
  }

  function updateScrollIndicator(reveal) {
    if (!scrollIndicator || !scrollThumb || !term || !term.buffer || !term.buffer.active) return;
    var buffer = term.buffer.active;
    var maxViewportY = buffer.baseY || 0;
    if (maxViewportY <= 0 || shouldRouteScrollToTerminalInput()) {
      scrollIndicator.classList.remove('visible');
      return;
    }
    var trackHeight = Math.max(0, window.innerHeight - 8);
    var totalRows = maxViewportY + (term.rows || 0);
    if (trackHeight <= 0 || totalRows <= 0) return;
    var thumbHeight = Math.max(24, trackHeight * (term.rows || 0) / totalRows);
    var maxTop = Math.max(0, trackHeight - thumbHeight);
    var top = maxViewportY > 0 ? (buffer.viewportY / maxViewportY) * maxTop : 0;
    scrollThumb.style.height = thumbHeight + 'px';
    scrollThumb.style.transform = 'translateY(' + top + 'px)';
    if (!reveal) return;
    scrollIndicator.classList.add('visible');
    if (scrollIndicatorHideTimer) clearTimeout(scrollIndicatorHideTimer);
    scrollIndicatorHideTimer = setTimeout(function() {
      scrollIndicator.classList.remove('visible');
      scrollIndicatorHideTimer = null;
    }, 550);
  }

`
