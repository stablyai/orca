// xterm.js WebView document + default Tokyonight theme; extracted from TerminalWebView.tsx for the max-lines budget.
import type { RuntimeMobileTerminalTheme } from '../../../src/shared/runtime-types'
import { colors } from '../theme/mobile-theme'
import { TERMINAL_TEXT_SCALES } from '../storage/preferences'
import { TERMINAL_PATH_TAP_JS } from './terminal-path-tap-injected'
import { XTERM_ENGINE_CSS, XTERM_ENGINE_JS } from './terminal-webview-engine.generated'
import { TERMINAL_REFLOW_JS } from './terminal-webview-reflow-injected'
import { TERMINAL_SURFACE_SWAP_JS } from './terminal-webview-surface-swap-injected'
import { TERMINAL_TAP_DISPATCH_JS } from './terminal-webview-tap-dispatch-injected'
import { TERMINAL_WEBVIEW_THEME_JS } from './terminal-webview-theme-injected'
import { TERMINAL_QUERY_REPLY_JS } from './terminal-webview-query-reply-injected'
import { URL_TAP_WEBVIEW_JS } from './terminal-webview-url-tap'
import { TERMINAL_WEBGL_RECOVERY_JS } from './terminal-webview-webgl-recovery-injected'

const DEFAULT_TERMINAL_THEME: RuntimeMobileTerminalTheme['theme'] = {
  background: colors.terminalBg,
  foreground: '#c0caf5',
  cursor: '#c0caf5',
  cursorAccent: colors.terminalBg,
  selectionBackground: '#33467c',
  selectionForeground: '#c0caf5',
  black: '#15161e',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#a9b1d6',
  brightBlack: '#414868',
  brightRed: '#f7768e',
  brightGreen: '#9ece6a',
  brightYellow: '#e0af68',
  brightBlue: '#7aa2f7',
  brightMagenta: '#bb9af7',
  brightCyan: '#7dcfff',
  brightWhite: '#c0caf5'
}

// Why: TUI escape codes assume the desktop's cols/rows, so init xterm at those dims and fit the phone via a measured CSS scale() instead of resizing.
export const XTERM_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<script>
window.__engineErrors = [];
window.onerror = function(msg) {
  // Why: a degraded engine can throw per frame; cap so the capture buffer
  // and downstream reporting stay bounded for the document's lifetime.
  if (window.__engineErrors.length < 20) window.__engineErrors.push(String(msg));
};
</script>
<style>${XTERM_ENGINE_CSS}</style>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    background: ${colors.terminalBg};
    overflow: hidden;
    width: 100%;
    height: 100%;
  }
  #terminal-container {
    overflow: hidden;
    position: relative;
    width: 100%;
    height: 100%;
  }
  #terminal-surface {
    transform-origin: top left;
    display: inline-block;
  }
  .xterm { -webkit-user-select: none; user-select: none; font-variant-emoji: text; }
  .xterm .xterm-viewport {
    overflow-y: hidden !important;
    scrollbar-width: none !important;
    -ms-overflow-style: none;
  }
  .xterm .xterm-viewport::-webkit-scrollbar {
    display: none !important;
    width: 0 !important;
    height: 0 !important;
    background: transparent !important;
  }
  .xterm .xterm-scrollable-element > .xterm-scrollbar,
  .xterm .xterm-scrollbar {
    display: none !important;
    width: 0 !important;
    opacity: 0 !important;
    pointer-events: none !important;
  }
  #scroll-indicator {
    position: fixed;
    top: 4px;
    right: 3px;
    bottom: 4px;
    width: 3px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 120ms linear;
    z-index: 7;
  }
  #scroll-indicator.visible { opacity: 0.72; }
  #scroll-thumb {
    position: absolute;
    top: 0;
    right: 0;
    width: 3px;
    min-height: 24px;
    border-radius: 999px;
    background: ${colors.textSecondary};
    will-change: transform, height;
  }
  /* Why: selection overlay sits in unscaled viewport coords, above the
     transformed surface, so handle hit areas and Copy menu positions
     don't depend on getTotalScale() for their on-screen size. */
  #selection-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    pointer-events: none;
    z-index: 10;
    display: none;
  }
  #selection-overlay.active { display: block; }
  .sel-handle {
    position: absolute;
    width: 44px; height: 44px;
    margin-left: -22px; margin-top: -22px;
    pointer-events: auto;
    background: transparent;
  }
  .sel-handle::before {
    content: '';
    position: absolute;
    left: 50%; top: 22px;
    transform: translateX(-50%);
    width: 14px; height: 14px;
    background: #7aa2f7;
    border-radius: 50%;
    border: 2px solid #c0caf5;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
  }
  .sel-handle.start::before { top: 8px; }
  .sel-handle.start::after {
    content: '';
    position: absolute;
    left: 50%; top: 22px;
    transform: translateX(-50%);
    width: 2px; height: 16px;
    background: #7aa2f7;
  }
  .sel-handle.end::before { top: 22px; }
  .sel-handle.end::after {
    content: '';
    position: absolute;
    left: 50%; top: 6px;
    transform: translateX(-50%);
    width: 2px; height: 16px;
    background: #7aa2f7;
  }
  #sel-menu {
    position: absolute;
    pointer-events: auto;
    background: #2a2f4a;
    border-radius: 8px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
    display: flex;
    overflow: hidden;
    transform: translateY(-100%);
    margin-top: -12px;
    user-select: none;
    -webkit-user-select: none;
  }
  #sel-menu button {
    background: transparent;
    border: none;
    color: #c0caf5;
    font: 600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    padding: 10px 16px;
    cursor: pointer;
  }
  #sel-menu button:active { background: #414868; }
  #sel-menu button + button { border-left: 1px solid #414868; }
</style>
</head>
<body>
<div id="terminal-container">
  <div id="terminal-surface"></div>
</div>
<div id="scroll-indicator"><div id="scroll-thumb"></div></div>
<div id="selection-overlay">
  <div id="sel-handle-start" class="sel-handle start"></div>
  <div id="sel-handle-end" class="sel-handle end"></div>
  <div id="sel-menu">
    <button id="sel-menu-copy">Copy</button>
    <button id="sel-menu-all">Select All</button>
  </div>
</div>
<script>${XTERM_ENGINE_JS}</script>
<script>
(function() {
  var surface = document.getElementById('terminal-surface');
  var ESC = String.fromCharCode(27);
  var C1_CSI = String.fromCharCode(155);
  var CLAUDE_STATUS_DOT = String.fromCharCode(0x23fa);
  var TEXT_PRESENTATION_SELECTOR = String.fromCharCode(0xfe0e);
  var EMOJI_PRESENTATION_SELECTOR = String.fromCharCode(0xfe0f);
  var CLAUDE_STATUS_DOT_PATTERN = new RegExp(CLAUDE_STATUS_DOT + '[' + TEXT_PRESENTATION_SELECTOR + EMOJI_PRESENTATION_SELECTOR + ']*', 'g');
  var statusDotPendingSelector = false;
  var PRIVATE_MODE_SCAN_TAIL_LIMIT = 4096;
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

${TERMINAL_WEBVIEW_THEME_JS}

  function getCellHeight() {
    if (!term || !term._core) return 15;
    var core = term._core;
    if (core._renderService && core._renderService.dimensions) {
      return core._renderService.dimensions.css.cell.height || 15;
    }
    return 15;
  }

  // Why: clamp pan so the terminal content always covers the viewport
  // when zoomed in. When content is smaller than viewport in a
  // dimension, pin to top-left (no floating in the middle).
  function clampPan() {
    if (!term || !term.element) return;
    var ts = getTotalScale();
    var cw = term.element.scrollWidth * ts;
    var ch = term.element.scrollHeight * ts;
    var vpW = window.innerWidth;
    var vpH = window.innerHeight;
    if (cw > vpW) {
      panX = Math.min(0, Math.max(vpW - cw, panX));
    } else {
      panX = 0;
    }
    if (ch > vpH) {
      panY = Math.min(0, Math.max(vpH - ch, panY));
    } else {
      panY = 0;
    }
  }

  // Why: intentional no-op. Mobile replays a live PTY snapshot then applies
  // live cursor-relative chunks from that same PTY; resizing only the WebView
  // xterm changes cursor coordinates and makes TUI repaint chunks duplicate or
  // overlap. Kept as a no-op so its call sites stay legible.
  function adjustRowsForViewport() {}

  // Why: cold-start fit. After init() opens xterm, the renderer needs
  // several frames before cell dimensions are computed. Reading too early
  // gives cellWidth=0 (renderer service not ready) or scrollWidth=0 (DOM
  // not laid out), and computeFitScale returns 1 → no zoom.
  //
  // Gate: cellWidth × cols is the canonical "logical width" of the grid
  // and reflects xterm's layout decision, independent of buffer content.
  // We commit when cellWidth becomes positive (renderer ready). Fallback:
  // if cellWidth never becomes available, gate on stable positive
  // scrollWidth (xterm rendered something). Cap at 60 frames (~1s @60Hz)
  // so a backgrounded WebView never spins forever.
  var FIT_RETRY_MAX_FRAMES = 60;
  var fitRetryToken = 0;
  function applyFitScale(reason) {
    if (!term || !term.element) return;
    var token = ++fitRetryToken;
    var attempts = 0;
    var lastScrollWidth = -1;
    function attempt() {
      if (token !== fitRetryToken) return;
      if (!term || !term.element) return;
      attempts++;
      var cellW = getCellWidth();
      if (cellW > 0 && term.cols > 0) {
        commitFitScale(reason, attempts, 'cellW');
        return;
      }
      var w = term.element.scrollWidth;
      if (w > 0 && w === lastScrollWidth) {
        commitFitScale(reason, attempts, 'stableSW');
        return;
      }
      lastScrollWidth = w;
      if (attempts >= FIT_RETRY_MAX_FRAMES) {
        flog('commit-timeout', {
          reason: reason,
          attempts: attempts,
          cellW: cellW,
          scrollWidth: w,
          cols: term.cols
        });
        commitFitScale(reason, attempts, 'timeout');
        return;
      }
      requestAnimationFrame(attempt);
    }
    requestAnimationFrame(attempt);
  }

  function commitFitScale(reason, attempts, gate) {
    if (!term || !term.element) return;
    var preSnapScale = computeFitScale();
    currentScale = preSnapScale;
    // Why: when scale is very close to 1 (e.g. 0.97 from xterm scrollbar
    // sub-pixels) snap to 1 to avoid imperceptible shrinkage that prevents
    // a second applyFitScale from observing a "no-op needed" state.
    if (currentScale >= 0.95) currentScale = 1;
    userScale = 1;
    panX = 0;
    panY = 0;
    smoothScrollOffsetY = 0;
    updateTransform();
    adjustRowsForViewport();

    var cellW = getCellWidth();
    var sw = term.element.scrollWidth;
    var vpW = window.innerWidth;
    var expectedW = cellW * term.cols;
    var suspect =
      currentScale === 1 && term.cols > 0 && expectedW > vpW + 1; // expected wider than viewport but no zoom
    if (suspect) {
      flog('commit-SUSPECT', {
        reason: reason,
        attempts: attempts,
        gate: gate,
        preSnapScale: preSnapScale,
        finalScale: currentScale,
        cellW: cellW,
        cols: term.cols,
        expectedW: expectedW,
        scrollWidth: sw,
        vpWidth: vpW
      });
    }
    repositionOverlay();
  }

  function isAltScreenActive(data) {
    if (typeof data !== 'string') return false;
    var on = data.lastIndexOf(ESC + '[?1049h');
    var off = data.lastIndexOf(ESC + '[?1049l');
    return on !== -1 && on > off;
  }

  function normalizeInitialData(data) {
    if (!isAltScreenActive(data)) return data;
    var on = data.lastIndexOf(ESC + '[?1049h');
    // Why: SerializeAddon can include normal-buffer scrollback before the
    // active alternate-screen snapshot. Replaying both into a fresh mobile
    // xterm duplicates TUI frames and can flatten SGR attributes.
    return on > 0 ? data.slice(on) : data;
  }

  function updateMouseModeFromData(data) {
    if (typeof data !== 'string' || data.length === 0) return;
    var input = mouseModeScanTail + data;
    mouseModeScanTail = extractMouseModeScanTail(input);
    var re = new RegExp(ESC + 'c|' + ESC + '\\\\[\\\\?([0-9;]+)([hl])|' + C1_CSI + '\\\\?([0-9;]+)([hl])', 'g');
    var match;
    while ((match = re.exec(input)) !== null) {
      if (match[0] === ESC + 'c') {
        trackedMouseTrackingMode = 'none';
        sgrMouseMode = false;
        sgrMousePixelsMode = false;
        continue;
      }
      var enabled = (match[2] || match[4]) === 'h';
      var params = (match[1] || match[3]).split(';');
      for (var i = 0; i < params.length; i++) {
        if (params[i] === '') continue;
        var param = Number(params[i]);
        if (!Number.isInteger(param)) continue;
        if (param === 9) trackedMouseTrackingMode = enabled ? 'x10' : 'none';
        if (param === 1000) trackedMouseTrackingMode = enabled ? 'vt200' : 'none';
        if (param === 1002) trackedMouseTrackingMode = enabled ? 'drag' : 'none';
        if (param === 1003) trackedMouseTrackingMode = enabled ? 'any' : 'none';
        if (param === 1006) {
          sgrMouseMode = enabled;
          sgrMousePixelsMode = false;
        }
        if (param === 1016) {
          sgrMouseMode = false;
          sgrMousePixelsMode = enabled;
        }
      }
    }
  }

  function resetWriteQueue() {
    writeQueue = [];
    writeQueueHead = 0;
  }

  function isStatusDotPresentationSelector(value) {
    return value === TEXT_PRESENTATION_SELECTOR || value === EMOJI_PRESENTATION_SELECTOR;
  }

  function endsWithStatusDotPresentationSequence(data) {
    var i = data.length - 1;
    while (i >= 0 && isStatusDotPresentationSelector(data.charAt(i))) i--;
    return i >= 0 && data.charAt(i) === CLAUDE_STATUS_DOT;
  }

  // Why: iOS WebKit promotes Claude's record/status dot to a colorful emoji glyph.
  function normalizeStatusDotPresentation(data) {
    if (typeof data !== 'string' || data.length === 0) return data;
    if (statusDotPendingSelector) {
      statusDotPendingSelector = false;
      var strippedPendingSelectors = false;
      while (data.length > 0 && isStatusDotPresentationSelector(data.charAt(0))) data = data.slice(1);
      strippedPendingSelectors = data.length === 0;
      if (strippedPendingSelectors) {
        statusDotPendingSelector = true;
        return '';
      }
    }
    var normalized = data.replace(CLAUDE_STATUS_DOT_PATTERN, CLAUDE_STATUS_DOT + TEXT_PRESENTATION_SELECTOR);
    statusDotPendingSelector = endsWithStatusDotPresentationSequence(data);
    return normalized;
  }

  function enqueueWrite(data) {
    writeQueue.push(normalizeStatusDotPresentation(data));
  }

  function enqueueWriteBoundary(callback) {
    writeQueue.push(callback);
  }

  function nextQueuedWrite() {
    if (writeQueueHead >= writeQueue.length) {
      resetWriteQueue();
      return undefined;
    }
    var next = writeQueue[writeQueueHead];
    writeQueueHead++;
    // Why: high-throughput terminals can enqueue faster than xterm parses;
    // compact consumed slots so drain work stays O(1) without retaining old chunks.
    if (writeQueueHead > 128 && writeQueueHead * 2 > writeQueue.length) {
      writeQueue = writeQueue.slice(writeQueueHead);
      writeQueueHead = 0;
    }
    return next;
  }

  function disposeTermObservers() {
    var disposables = termObserverDisposables;
    termObserverDisposables = [];
    for (var i = 0; i < disposables.length; i++) {
      try { disposables[i] && disposables[i].dispose && disposables[i].dispose(); } catch (e) {}
    }
  }

  function extractMouseModeScanTail(input) {
    var start = Math.max(input.lastIndexOf(ESC), input.lastIndexOf(C1_CSI));
    if (start === -1) return '';
    var tail = input.slice(start);
    // Why: PTY/SSH chunks can split a long combined DECSET before the final h/l.
    // Keep parser state far beyond normal mode lists while still bounding memory.
    if (tail.length > PRIVATE_MODE_SCAN_TAIL_LIMIT) return '';
    if (tail === ESC || tail === ESC + '[' || tail === C1_CSI) return tail;
    if (tail.indexOf(ESC + '[?') === 0) {
      return /^[0-9;]*$/.test(tail.slice(3)) ? tail : '';
    }
    if (tail.indexOf(C1_CSI + '?') === 0) {
      return /^[0-9;]*$/.test(tail.slice(2)) ? tail : '';
    }
    return '';
  }

  function pumpWrites(gen) {
    if (!ready || !term || writesDraining || gen !== terminalGeneration) return;
    var next = nextQueuedWrite();
    if (typeof next !== 'string') {
      if (typeof next === 'function') return next(), pumpWrites(gen);
      var callbacks = afterDrainCallbacks;
      afterDrainCallbacks = [];
      for (var i = 0; i < callbacks.length; i++) callbacks[i]();
      return;
    }
    writesDraining = true;
    // Why: xterm.write() parses asynchronously. Row adjustment/resizing must
    // wait until replayed SGR attributes have landed in the buffer.
    term.write(next, function() {
      if (gen !== terminalGeneration) return;
      writesDraining = false;
      pumpWrites(gen);
    });
  }

  function afterWritesDrained(callback) {
    afterDrainCallbacks.push(callback);
    pumpWrites(terminalGeneration);
  }

${TERMINAL_WEBGL_RECOVERY_JS}

  function init(cols, rows, initialData, nextTheme, nextFontScale, preserveScroll, nextOscLinks) {
    if (typeof nextFontScale === 'number' && nextFontScale > 0) currentTextScale = nextFontScale;
    // Why: a width-reflow re-stream rewraps the same content at new cols.
    // Distance-from-bottom (rows) is the only stable anchor across reflow,
    // since line counts and cell positions change. null = stay pinned to bottom.
    var prevB = preserveScroll && term && term.buffer && term.buffer.active ? term.buffer.active : null;
    var scrollAnchorRows = prevB ? Math.max(0, (prevB.baseY || 0) - (prevB.viewportY || 0)) : -1;
    terminalGeneration++;
    var gen = terminalGeneration;
    // Why: snapshot replay can contain old queries whose replies must never
    // re-enter the live PTY. Each replacement terminal earns authority anew.
    resetTerminalDataReplyAuthority();
    cancelWebglContextRecovery();
    webglAddon = null;
    ready = false;
    resetWriteQueue();
    statusDotPendingSelector = false;
    writesDraining = false;
    afterDrainCallbacks = [];
    initRows = rows || 24;
    firstDataPending = true;
    smoothScrollOffsetY = 0;
    mouseModeScanTail = '';
    trackedMouseTrackingMode = 'none';
    sgrMouseMode = false;
    sgrMousePixelsMode = false;
    lastEmittedModes = {
      bracketedPasteMode: false,
      altScreen: false,
      mouseTrackingMode: 'none',
      sgrMouseMode: false,
      sgrMousePixelsMode: false
    };
    var replayData = normalizeInitialData(initialData);
    // Why: normalizeInitialData can discard pre-alt-screen bytes. Keep the
    // mirrored modes aligned with exactly what this mobile xterm replays.
    updateMouseModeFromData(replayData);
    activeAltScreenSnapshot = isAltScreenActive(replayData);
    initialOscLinks = Array.isArray(nextOscLinks) ? nextOscLinks : [];
    initialOscLinkRowOffset = 0;
    initialOscLinkEvictionReady = false;
    var surfaceSwap = beginTerminalSurfaceSwap();
    var nextSurface = surfaceSwap.nextSurface;

    applyTerminalTheme(nextTheme);
    term = new Terminal({
      cols: cols || 80,
      rows: rows || 24,
      theme: terminalTheme,
      minimumContrastRatio: terminalMinimumContrastRatio,
      fontFamily: terminalFontFamily,
      fontSize: fontPxForScale(currentTextScale),
      fontWeight: '300',
      fontWeightBold: '500',
      scrollback: 5000,
      // Why: xterm suppresses parser-generated query replies when disableStdin
      // is true. Native accepts only validated reply grammars from onData.
      disableStdin: false,
      cursorBlink: false,
      cursorStyle: 'bar',
      // Why: native TextInput owns mobile keyboard focus, so xterm stays inactive.
      // Match its active bar while still honoring application cursor-hide sequences.
      cursorInactiveStyle: 'bar',
      convertEol: false,
      allowProposedApi: true
    });
    var nextTerm = term;
    pendingTerm = nextTerm;
    term.open(surface);
    attachWebglAddon(true);
    if (window.Unicode11Addon && window.Unicode11Addon.Unicode11Addon) try { term.loadAddon(new window.Unicode11Addon.Unicode11Addon()); term.unicode.activeVersion = '11'; } catch (e) {}
    if (typeof replayData === 'string' && replayData.length > 0) {
      enqueueWrite(replayData);
    }

    // Why: reset eviction tracking + attach observers for the new term.
    resetEvictionCounter();
    cancelSelect();
    attachTermObservers();
    attachTerminalQueryReplyBridge(term, gen);

    requestAnimationFrame(function() {
      if (gen !== terminalGeneration) return;
      ready = true;
      everReady = true;
      afterWritesDrained(function() {
        if (gen !== terminalGeneration) return;
        commitTerminalSurfaceSwap(surfaceSwap, nextTerm);
        // Why: restore the reader's place after the rewrapped buffer replays.
        // Replay lands at bottom, so only act when they were scrolled up (rows>0).
        if (scrollAnchorRows > 0 && term && term.buffer && term.buffer.active) {
          try { term.scrollToLine(Math.max(0, (term.buffer.active.baseY || 0) - scrollAnchorRows)); } catch (e) {}
        }
        captureInitialOscLinkTexts();
        initialOscLinkRowOffset = 0;
        initialOscLinkEvictionReady = true;
        applyFitScale('init-replay');
        notify({ type: 'ready', cols: cols, rows: rows });
      });
    });
  }

  function write(data) {
    updateMouseModeFromData(data);
    enqueueWrite(data);
    pumpWrites(terminalGeneration);
    // Why: first live data chunk after init may widen the buffer past
    // what the post-replay applyFitScale measured. Re-fit once after this
    // chunk drains to catch the wider line. Subsequent chunks don't re-fit
    // (the user's manual zoom is sticky after that).
    if (firstDataPending) {
      firstDataPending = false;
      var gen = terminalGeneration;
      afterWritesDrained(function() {
        if (gen !== terminalGeneration) return;
        applyFitScale('first-data');
      });
    }
  }

  function resize(cols, rows) {
    if (!term) return;
    initRows = rows || initRows;
    term.resize(cols || term.cols, rows || term.rows);
    applyFitScale('resize-msg');
    notify({ type: 'ready', cols: cols, rows: rows });
  }

  // reflow(): see terminal-webview-reflow-injected.ts (extracted for max-lines).
  ${TERMINAL_REFLOW_JS}

  function notify(msg) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(msg));
    }
  }

  function engineErrorText(err) {
    if (!err) return '';
    if (typeof err === 'string') return err;
    if (err && typeof err.message === 'string') return err.message;
    try { return String(err); } catch (e) { return ''; }
  }

  function chromeVersionText() {
    var match = String(navigator.userAgent || '').match(/(?:Chrome|Chromium)\\/([0-9.]+)/);
    return match ? 'Chrome ' + match[1] : 'Chrome version unknown';
  }

  var nonFatalErrorNotifies = 0;

  function reportEngineError(context, err, fatal) {
    var isFatal = fatal === undefined ? !everReady : !!fatal;
    if (!isFatal) {
      // Why: a constructed-but-degraded engine can throw per frame; cap
      // non-fatal notifies so RN isn't flooded. Fatal reports always emit.
      nonFatalErrorNotifies++;
      if (nonFatalErrorNotifies > 5) return;
    }
    var parts = [context];
    var errText = engineErrorText(err);
    if (errText) parts.push(errText);
    if (window.__engineErrors && window.__engineErrors.length) {
      parts.push('captured: ' + window.__engineErrors.join(' | '));
    }
    parts.push(chromeVersionText());
    notify({
      type: 'error',
      fatal: isFatal,
      message: parts.join(' - ')
    });
  }

  window.onerror = function(msg, source, line, column, err) {
    if (window.__engineErrors.length < 20) window.__engineErrors.push(String(msg));
    reportEngineError('terminal runtime error', err || msg);
  };

  function measureFitDimensions(containerHeightPx, retriesLeft) {
    if (typeof retriesLeft !== 'number') retriesLeft = 30;
    // Why: init and measure are posted back-to-back from React, but
    // init has an async rAF chain. A measure that runs synchronously
    // after init can find term null, disposed, lacking element, or
    // with cells size 0. Retry the whole gate for ~500ms.
    var notReady = !term || !term.element;
    var cellWidth = 0;
    var cellHeight = 0;
    if (!notReady) {
      var core = term._core;
      if (core && core._renderService && core._renderService.dimensions) {
        cellWidth = core._renderService.dimensions.css.cell.width;
        cellHeight = core._renderService.dimensions.css.cell.height;
      }
    }
    if (notReady || cellWidth <= 0 || cellHeight <= 0) {
      if (retriesLeft > 0) {
        requestAnimationFrame(function() {
          measureFitDimensions(containerHeightPx, retriesLeft - 1);
        });
        return;
      }
      flog('measure-fail', {
        notReady: notReady,
        cellWidth: cellWidth,
        cellHeight: cellHeight,
        retriesLeft: retriesLeft
      });
      notify({ type: 'measure-result', cols: null, rows: null });
      return;
    }
    var vpWidth = window.innerWidth;
    // Why: prefer the container height passed from React Native over
    // window.innerHeight. The RN layout system knows the exact pixel
    // height of the terminal frame after the accessory/input bars are
    // subtracted, whereas innerHeight can overstate the visible area
    // due to layout timing or safe-area insets.
    var vpHeight = (typeof containerHeightPx === 'number' && containerHeightPx > 0)
      ? containerHeightPx
      : window.innerHeight;
    var cols = Math.floor(vpWidth / cellWidth);
    if (cols < MIN_FIT_COLS) {
      flog('measure-skip-small-width', {
        vpWidth: vpWidth,
        cellWidth: cellWidth,
        cols: cols
      });
      notify({ type: 'measure-result', cols: null, rows: null });
      return;
    }
    // Why: the rows we report become the PTY's actual row count after the
    // server fits to viewport, and xterm renders exactly that many lines
    // anchored top-left of the WebView. Subtracting rows here would leave
    // dead xterm-background space at the bottom of the container and make
    // the last PTY rows visually appear above an "invisible line." Any
    // safety margin between the prompt and the accessory bar must come
    // from RN layout (terminalFrame's flex bounds), not from undersizing
    // the PTY.
    var rows = Math.max(8, Math.floor(vpHeight / cellHeight));
    notify({ type: 'measure-result', cols: cols, rows: rows });
  }

  function handleMsg(msg) {
    if (typeof msg.id === 'number') {
      if (handledMessageIds.indexOf(msg.id) !== -1) return;
      handledMessageIds.push(msg.id);
      if (handledMessageIds.length > 256) handledMessageIds.shift();
    }
    if (msg.type === 'ping') {
      notify({ type: 'pong', pingId: msg.id });
    } else if (msg.type === 'init') {
      init(msg.cols, msg.rows, msg.initialData, msg.terminalTheme, msg.fontScale, msg.preserveScroll, msg.oscLinks);
    } else if (msg.type === 'set-font-scale') {
      // Why: ignore RN echoing back the value a pinch just set (msg.fontScale ===
      // currentTextScale) so the post-pinch state isn't reset; only apply changes.
      if (typeof msg.fontScale === 'number' && msg.fontScale > 0 && msg.fontScale !== currentTextScale) {
        userScale = 1;
        panX = 0;
        panY = 0;
        applyTextScale(msg.fontScale);
      }
    } else if (msg.type === 'resize') {
      resize(msg.cols, msg.rows);
    } else if (msg.type === 'reflow') { reflow(msg.cols, msg.rows);
    } else if (msg.type === 'write') {
      write(msg.data);
    } else if (msg.type === 'clear') {
      terminalGeneration++;
      resetWriteQueue(); resumeTerminalDataReplyAuthority(); // Why: clear drops the replay boundary.
      statusDotPendingSelector = false;
      afterDrainCallbacks = [];
      writesDraining = false;
      mouseModeScanTail = '';
      trackedMouseTrackingMode = 'none';
      sgrMouseMode = false;
      sgrMousePixelsMode = false;
      initialOscLinks = [];
      initialOscLinkRowOffset = 0;
      initialOscLinkEvictionReady = false;
      if (term) { term.clear(); term.reset(); }
      emitModesIfChanged();
      resetEvictionCounter();
      if (selMode === 'select') {
        notify({ type: 'selection-evicted' });
        cancelSelect();
      }
    } else if (msg.type === 'measure') {
      measureFitDimensions(msg.containerHeight);
    } else if (msg.type === 'reset-zoom') {
      applyFitScale('reset-zoom-msg');
    } else if (msg.type === 'set-theme') {
      applyTerminalTheme(msg.terminalTheme);
    } else if (msg.type === 'cancel-select') {
      if (selMode === 'select') cancelSelect();
    } else if (msg.type === 'do-select-all') {
      if (term) {
        try {
          term.selectAll();
          var b = term.buffer.active;
          if (selMode !== 'select') {
            selMode = 'select';
            selectionOverlay.classList.add('active');
            notify({ type: 'set-select-mode', enabled: true });
          }
          sel = {
            anchor: { col: 0, row: 0 },
            focus: { col: term.cols - 1, row: b.length - 1 },
            activeHandle: null
          };
          repositionOverlay();
        } catch (e) {}
      }
    }
  }

  // ============================================================
  // SELECTION MODE (long-press → handles → Copy)
  // ============================================================
  var WORD_RE = /[\\p{L}\\p{N}_./:@~+=?&#%-]/u;
  var LONG_PRESS_MS = 500;
  var LONG_PRESS_SLOP = 10;
  // Why: a tap that opens a link/path must survive small finger jitter. The
  // long-press slop (10px) only cancels the press-to-select timer; reusing it
  // to gate the tap dropped any URL/file tap that wandered >10px — at fit scale
  // a few screen px of jitter is a normal tap. Use a wider, time-bounded tap
  // window so deliberate scrolls/pans still don't fire a tap.
  var TAP_SLOP = 24;
  var TAP_MAX_MS = 700;
  var EDGE_SCROLL_PX = 40;
  var EDGE_SCROLL_INTERVAL = 60;

  var selectionOverlay = document.getElementById('selection-overlay');
  var handleStart = document.getElementById('sel-handle-start');
  var handleEnd = document.getElementById('sel-handle-end');
  var selMenu = document.getElementById('sel-menu');
  var btnCopy = document.getElementById('sel-menu-copy');
  var btnSelAll = document.getElementById('sel-menu-all');

  // mode: 'navigate' | 'select'
  var selMode = 'navigate';
  var sel = null; // { anchor:{col,row}, focus:{col,row}, activeHandle:null|'start'|'end' }
  var longPressTimer = null;
  var longPressOrigin = null; // {x,y, identifier}
  // Why: tap detection is tracked separately from the long-press timer so a
  // small jitter that cancels the press-to-select timer does not also cancel
  // the tap (which opens links/paths). {x,y,t,identifier} or null once the
  // gesture is disqualified as a tap (moved too far or held too long).
  var tapCandidate = null;
  var edgeScrollTimer = null;
  var edgeScrollDir = 0;
  var edgeScrollClientX = 0;
  var edgeScrollClientY = 0;

  // Eviction watchdog: linesEverWritten counts onLineFeed since last init.
  // Once buffer is full, every onLineFeed evicts the top row in xterm and
  // we mirror that by decrementing stored absolute rows.
  var linesEverWritten = 0;

  function resetEvictionCounter() { linesEverWritten = 0; }

  function isBufferFull() {
    if (!term) return false;
    return linesEverWritten >= 5000 + (term.rows || 0);
  }

  function checkEviction() {
    if (selMode !== 'select' || !sel) return;
    var oldest = Math.min(sel.anchor.row, sel.focus.row);
    if (oldest < 0) {
      notify({ type: 'selection-evicted' });
      cancelSelect();
    }
  }

  function logFeedAndEvict() {
    linesEverWritten++;
    if (initialOscLinkEvictionReady && isBufferFull()) initialOscLinkRowOffset += 1;
    if (selMode === 'select' && sel && isBufferFull()) {
      sel.anchor.row -= 1;
      sel.focus.row -= 1;
      checkEviction();
      repositionOverlay();
    }
  }

  function emitModesIfChanged() {
    if (!term) return;
    var bp = !!(term.modes && term.modes.bracketedPasteMode);
    var alt = false;
    var mouseTrackingMode = getMouseTrackingMode();
    try { alt = term.buffer && term.buffer.active && term.buffer.active.type === 'alternate'; } catch (e) {}
    if (
      bp !== lastEmittedModes.bracketedPasteMode ||
      alt !== lastEmittedModes.altScreen ||
      mouseTrackingMode !== lastEmittedModes.mouseTrackingMode ||
      sgrMouseMode !== lastEmittedModes.sgrMouseMode ||
      sgrMousePixelsMode !== lastEmittedModes.sgrMousePixelsMode
    ) {
      lastEmittedModes = {
        bracketedPasteMode: bp,
        altScreen: alt,
        mouseTrackingMode: mouseTrackingMode,
        sgrMouseMode: sgrMouseMode,
        sgrMousePixelsMode: sgrMousePixelsMode
      };
      notify({
        type: 'modes',
        bracketedPasteMode: bp,
        altScreen: alt,
        mouseTrackingMode: mouseTrackingMode,
        sgrMouseMode: sgrMouseMode,
        sgrMousePixelsMode: sgrMousePixelsMode
      });
    }
  }
  var lastEmittedModes = {
    bracketedPasteMode: false,
    altScreen: false,
    mouseTrackingMode: 'none',
    sgrMouseMode: false,
    sgrMousePixelsMode: false
  };

  function emitKeyboardAvoidanceMetrics() {
    if (!term) return;
    var alt = false;
    try { alt = term.buffer && term.buffer.active && term.buffer.active.type === 'alternate'; } catch (e) {}
    notify({
      type: 'keyboard-avoidance-metrics',
      cursorY: term.buffer && term.buffer.active ? term.buffer.active.cursorY : 0,
      rows: term.rows || 0,
      altScreen: alt
    });
  }

  function attachTermObservers() {
    if (!term) return;
    disposeTermObservers();
    try { termObserverDisposables.push(term.onLineFeed(logFeedAndEvict)); } catch (e) {}
    try {
      termObserverDisposables.push(term.onScroll(function() { updateScrollIndicator(false); }));
    } catch (e) {}
    // Why: emit modes on every parsed write so RN's mirror stays current
    // without round-trip; covers \\x1b[?2004h/l and alt-screen toggles.
    try {
      if (term.onWriteParsed) {
        termObserverDisposables.push(term.onWriteParsed(function() {
          emitModesIfChanged();
          emitKeyboardAvoidanceMetrics();
        }));
      }
    } catch (e) {}
    // Initial emit once buffer settles.
    afterWritesDrained(function() {
      emitModesIfChanged();
      emitKeyboardAvoidanceMetrics();
    });
  }

  function viewportToCell(clientX, clientY) {
    if (!term) return null;
    var cellW = getCellWidth();
    var cellH = getCellHeight();
    if (cellW <= 0 || cellH <= 0) return null;
    var total = getTotalScale();
    if (total <= 0) total = 1;
    var sx = (clientX - panX) / total;
    var sy = (clientY - panY) / total;
    var col = Math.floor(sx / cellW);
    var viewportRow = Math.floor(sy / cellH);
    if (col < 0) col = 0;
    if (col > term.cols - 1) col = term.cols - 1;
    if (viewportRow < 0) viewportRow = 0;
    if (viewportRow > term.rows - 1) viewportRow = term.rows - 1;
    var viewportY = term.buffer.active.viewportY;
    return { col: col, row: viewportRow + viewportY };
  }

  function viewportToMouseReportCell(clientX, clientY) {
    if (!term) return null;
    var cellW = getCellWidth();
    var cellH = getCellHeight();
    if (cellW <= 0 || cellH <= 0) return null;
    if (typeof clientX !== 'number') clientX = window.innerWidth / 2;
    if (typeof clientY !== 'number') clientY = window.innerHeight / 2;
    var total = getTotalScale();
    if (total <= 0) total = 1;
    var sx = (clientX - panX) / total;
    var sy = (clientY - panY) / total;
    var maxX = Math.max(0, term.cols * cellW - 1);
    var maxY = Math.max(0, term.rows * cellH - 1);
    if (sx < 0) sx = 0;
    if (sx > maxX) sx = maxX;
    if (sy < 0) sy = 0;
    if (sy > maxY) sy = maxY;
    var col = Math.floor(sx / cellW);
    var row = Math.floor(sy / cellH);
    if (col < 0) col = 0;
    if (col > term.cols - 1) col = term.cols - 1;
    if (row < 0) row = 0;
    if (row > term.rows - 1) row = term.rows - 1;
    return { col: col, row: row, x: Math.floor(sx), y: Math.floor(sy) };
  }

  function isAlternateBufferActive() {
    try {
      return !!(term && term.buffer && term.buffer.active && term.buffer.active.type === 'alternate');
    } catch (e) {
      return false;
    }
  }

  function getMouseTrackingMode() {
    try {
      if (term && term.modes && typeof term.modes.mouseTrackingMode === 'string') {
        var mode = term.modes.mouseTrackingMode;
        if (mode === 'x10' || mode === 'vt200' || mode === 'drag' || mode === 'any') return mode;
        return 'none';
      }
    } catch (e) {}
    if (
      trackedMouseTrackingMode === 'x10' ||
      trackedMouseTrackingMode === 'vt200' ||
      trackedMouseTrackingMode === 'drag' ||
      trackedMouseTrackingMode === 'any'
    ) {
      return trackedMouseTrackingMode;
    }
    return 'none';
  }

  function repeatSequence(sequence, count) {
    var out = '';
    for (var i = 0; i < count; i++) out += sequence;
    return out;
  }

  function buildArrowScrollSequence(lines) {
    var prefix = '[';
    try {
      if (term && term.modes && term.modes.applicationCursorKeysMode) prefix = 'O';
    } catch (e) {}
    return ESC + prefix + (lines < 0 ? 'A' : 'B');
  }

  function buildMouseWheelSequence(lines, clientX, clientY) {
    var cell = viewportToMouseReportCell(clientX, clientY);
    if (!cell) return '';
    var eventCode = lines < 0 ? 64 : 65;
    if (sgrMousePixelsMode) {
      if (!isSafeSgrMouseCoordinate(cell.x) || !isSafeSgrMouseCoordinate(cell.y)) return '';
      return ESC + '[<' + eventCode + ';' + cell.x + ';' + cell.y + 'M';
    }
    if (sgrMouseMode) {
      // Why: xterm increments zero-based mouse cells before encoding reports.
      var sgrCol = cell.col + 1;
      var sgrRow = cell.row + 1;
      if (!isSafeSgrMouseCoordinate(sgrCol) || !isSafeSgrMouseCoordinate(sgrRow)) return '';
      return ESC + '[<' + eventCode + ';' + sgrCol + ';' + sgrRow + 'M';
    }
    // Why: xterm increments zero-based mouse cells before encoding reports.
    var button = eventCode + 32;
    var col = cell.col + 1 + 32;
    var row = cell.row + 1 + 32;
    // Why: non-SGR mouse bytes above ASCII are not preserved reliably through
    // the mobile JSON/RPC string path. Fall back to keys for wide terminals.
    if (button > 126 || col > 126 || row > 126) return '';
    return ESC + '[M' + String.fromCharCode(button) + String.fromCharCode(col) + String.fromCharCode(row);
  }

  function isSafeSgrMouseCoordinate(value) {
    return Number.isInteger(value) && value >= 0 && value <= 9999;
  }

  function buildMouseClickInput(clientX, clientY) {
    var mouseTrackingMode = getMouseTrackingMode();
    if (!isClickMouseTrackingMode(mouseTrackingMode)) return '';
    var cell = viewportToMouseReportCell(clientX, clientY);
    if (!cell) return '';
    if (sgrMousePixelsMode) {
      // Why: xterm 1016 keeps SGR syntax but reports raw zero-based pixel positions.
      var pixelX = cell.x;
      var pixelY = cell.y;
      if (!isSafeSgrMouseCoordinate(pixelX) || !isSafeSgrMouseCoordinate(pixelY)) return '';
      var pixelPress = ESC + '[<0;' + pixelX + ';' + pixelY + 'M';
      if (mouseTrackingMode === 'x10') return pixelPress;
      return pixelPress + ESC + '[<0;' + pixelX + ';' + pixelY + 'm';
    }
    if (sgrMouseMode) {
      // Why: xterm increments zero-based mouse cells before encoding reports.
      var sgrCol = cell.col + 1;
      var sgrRow = cell.row + 1;
      if (!isSafeSgrMouseCoordinate(sgrCol) || !isSafeSgrMouseCoordinate(sgrRow)) return '';
      var sgrPress = ESC + '[<0;' + sgrCol + ';' + sgrRow + 'M';
      if (mouseTrackingMode === 'x10') return sgrPress;
      return sgrPress + ESC + '[<0;' + sgrCol + ';' + sgrRow + 'm';
    }
    // Why: non-SGR click coordinates use printable ASCII bytes on the mobile
    // bridge; unsafe wide-terminal cells must not turn into corrupted input.
    var col = cell.col + 1 + 32;
    var row = cell.row + 1 + 32;
    if (col > 126 || row > 126) return '';
    var press = ESC + '[M' + String.fromCharCode(32) + String.fromCharCode(col) + String.fromCharCode(row);
    if (mouseTrackingMode === 'x10') return press;
    return press + ESC + '[M' + String.fromCharCode(35) + String.fromCharCode(col) + String.fromCharCode(row);
  }

  function isClickMouseTrackingMode(mode) {
    return mode !== 'none';
  }

  function isWheelMouseTrackingMode(mode) {
    return mode !== 'none' && mode !== 'x10';
  }

  function shouldRouteScrollToTerminalInput() {
    return isWheelMouseTrackingMode(getMouseTrackingMode()) || isAlternateBufferActive();
  }

  function buildMouseWheelScrollInput(lines, clientX, clientY) {
    var count = Math.min(Math.abs(lines), 32);
    if (count === 0) return '';
    var sequence = buildMouseWheelSequence(lines, clientX, clientY);
    if (!sequence) return '';
    return repeatSequence(sequence, count);
  }

  function buildTuiScrollInput(lines, clientX, clientY) {
    var count = Math.min(Math.abs(lines), 32);
    if (count === 0) return '';
    var mouseTrackingMode = getMouseTrackingMode();
    var sequence = '';
    if (isWheelMouseTrackingMode(mouseTrackingMode)) {
      sequence = buildMouseWheelSequence(lines, clientX, clientY);
    }
    if (!sequence) sequence = buildArrowScrollSequence(lines);
    return repeatSequence(sequence, count);
  }

  function routeScrollLines(lines, clientX, clientY) {
    if (!term || lines === 0) return;
    var mouseTrackingMode = getMouseTrackingMode();
    var alternateBufferActive = isAlternateBufferActive();
    if (isWheelMouseTrackingMode(mouseTrackingMode)) {
      // Why: xterm sends wheel events to mouse-aware TUIs before considering
      // scrollback, even if the app stays on the normal buffer.
      var mouseInput = buildMouseWheelScrollInput(lines, clientX, clientY);
      if (mouseInput) {
        notify({ type: 'terminal-input', bytes: mouseInput });
        return;
      }
      // Why: default mouse encoding can be unrepresentable in our ASCII-safe
      // RPC path on wide terminals. Send bounded arrows instead of local
      // scrollback/no-op while a mouse-aware app owns scroll gestures.
      var fallbackInput = buildTuiScrollInput(lines, clientX, clientY);
      if (fallbackInput) notify({ type: 'terminal-input', bytes: fallbackInput });
      return;
    }
    if (alternateBufferActive) {
      // Why: alternate-screen TUIs own their scroll state and xterm has no
      // scrollback there, so mobile scroll gestures must become terminal input.
      var input = buildTuiScrollInput(lines, clientX, clientY);
      if (input) notify({ type: 'terminal-input', bytes: input });
      return;
    }
    term.scrollLines(lines);
  }

  function clampNormalScrollLines(lines) {
    if (!term || !term.buffer || !term.buffer.active || lines === 0) return 0;
    var buffer = term.buffer.active;
    if (lines > 0) {
      return Math.min(lines, Math.max(0, buffer.baseY - buffer.viewportY));
    }
    return Math.max(lines, -buffer.viewportY);
  }

  function canScrollNormalBufferDelta(deltaY) {
    if (!term || !term.buffer || !term.buffer.active || deltaY === 0) return false;
    var buffer = term.buffer.active;
    if (deltaY > 0) return buffer.viewportY < buffer.baseY;
    return buffer.viewportY > 0;
  }

  function applyNormalBufferScrollDelta(deltaY) {
    if (!term || deltaY === 0) return false;
    var effectiveCellH = getCellHeight() * getTotalScale();
    if (effectiveCellH <= 0) return false;
    if (!canScrollNormalBufferDelta(deltaY)) {
      resetSmoothScrollOffset();
      return false;
    }
    smoothScrollOffsetY -= deltaY;
    var lines = Math.trunc(-smoothScrollOffsetY / effectiveCellH);
    if (lines !== 0) {
      var applied = clampNormalScrollLines(lines);
      if (applied !== 0) {
        term.scrollLines(applied);
        // Why: xterm's renderer is row-based. Buffer touch pixels and only
        // commit whole rows so TUI canvas layers do not shimmer between
        // fractional transforms and xterm repaints.
        smoothScrollOffsetY += applied * effectiveCellH;
      }
      if (applied !== lines) smoothScrollOffsetY = 0;
    }
    var limit = effectiveCellH - 1;
    if (smoothScrollOffsetY > limit) smoothScrollOffsetY = limit;
    if (smoothScrollOffsetY < -limit) smoothScrollOffsetY = -limit;
    updateScrollIndicator(true);
    return true;
  }

  function enqueueNormalBufferScrollDelta(deltaY) {
    if (!term || deltaY === 0) return false;
    if (!canScrollNormalBufferDelta(deltaY)) {
      resetSmoothScrollOffset();
      return false;
    }
    pendingNormalScrollDeltaY += deltaY;
    if (normalScrollFrameId !== null) return true;
    // Why: dense terminal rows are expensive to repaint. Coalesce touchmove
    // deltas into one xterm row-scroll per frame instead of repainting from
    // the input event stream.
    normalScrollFrameId = requestAnimationFrame(function() {
      normalScrollFrameId = null;
      var delta = pendingNormalScrollDeltaY;
      pendingNormalScrollDeltaY = 0;
      if (!applyNormalBufferScrollDelta(delta)) {
        resetSmoothScrollOffset();
      }
    });
    return true;
  }

  function resetSmoothScrollOffset() {
    pendingNormalScrollDeltaY = 0;
    if (normalScrollFrameId !== null) {
      cancelAnimationFrame(normalScrollFrameId);
      normalScrollFrameId = null;
    }
    if (smoothScrollOffsetY === 0) return;
    smoothScrollOffsetY = 0;
    updateScrollIndicator(false);
  }

  function cellToViewportPx(col, absRow) {
    if (!term) return { x: 0, y: 0 };
    var cellW = getCellWidth();
    var cellH = getCellHeight();
    var viewportRow = absRow - term.buffer.active.viewportY;
    var sx = col * cellW;
    var sy = viewportRow * cellH;
    var total = getTotalScale();
    return { x: sx * total + panX, y: sy * total + panY };
  }

  function getLineText(absRow) {
    if (!term) return '';
    var line = term.buffer.active.getLine(absRow);
    if (!line) return '';
    return line.translateToString(false);
  }

  // Why: getLineText collapses wide chars (emoji, CJK) to one string char, so a
  // tap's CELL column no longer equals the STRING index that url/path matchers use.
  // Convert by measuring the string length up to the tapped cell (the count of
  // string chars before it). Without this, taps on lines with a leading wide char
  // (e.g. agent output prefixed with ⏺) resolve to the wrong column and miss.
  function cellColToStringIndex(absRow, col) {
    if (!term) return col;
    var line = term.buffer.active.getLine(absRow);
    if (!line) return col;
    return line.translateToString(false, 0, col).length;
  }

  // File-path-under-tap detection (matchFilePathAtColumn). See
  // terminal-path-tap-injected.ts; mirrors the unit-tested terminal-path-tap.ts.
  ${TERMINAL_PATH_TAP_JS}
  ${URL_TAP_WEBVIEW_JS}

  function seedWordSelection(col, absRow) {
    var line = getLineText(absRow);
    if (!line) {
      sel = { anchor: { col: col, row: absRow }, focus: { col: col, row: absRow }, activeHandle: null };
      applyXtermSelection();
      return;
    }
    var s = col;
    var e = col;
    if (col >= 0 && col < line.length && WORD_RE.test(line[col])) {
      while (s > 0 && WORD_RE.test(line[s - 1])) s--;
      while (e < line.length - 1 && WORD_RE.test(line[e + 1])) e++;
    }
    sel = {
      anchor: { col: s, row: absRow },
      focus: { col: e, row: absRow },
      activeHandle: null
    };
    applyXtermSelection();
  }

  function isStartFirst(a, b) {
    if (a.row !== b.row) return a.row < b.row;
    return a.col <= b.col;
  }

  function selRange() {
    if (!sel) return null;
    if (isStartFirst(sel.anchor, sel.focus)) return { start: sel.anchor, end: sel.focus };
    return { start: sel.focus, end: sel.anchor };
  }

  function applyXtermSelection() {
    if (!term || !sel) return;
    var r = selRange();
    if (!r) return;
    // Why: term.select(col, row, length) takes a buffer-absolute row,
    // not a viewport-relative one. Subtracting viewportY here drifts the
    // selection by the scrollback height — handles render where the user
    // pressed (their math is independent), but xterm highlights an
    // off-screen scrollback region and copies the wrong text.
    var length;
    if (r.start.row === r.end.row) {
      length = Math.max(1, r.end.col - r.start.col + 1);
    } else {
      var first = term.cols - r.start.col;
      var middle = Math.max(0, r.end.row - r.start.row - 1) * term.cols;
      var last = r.end.col + 1;
      length = first + middle + last;
    }
    try { term.select(r.start.col, r.start.row, length); } catch (e) {}
  }

  function cancelSelect() {
    selMode = 'navigate';
    sel = null;
    stopEdgeScroll();
    if (term) {
      try { term.clearSelection(); } catch (e) {}
      // Why: some xterm renderers cache cells and skip repaint on
      // clearSelection alone, leaving the previously-highlighted cells
      // visually selected. Force a full refresh so the selection layer
      // actually clears on screen.
      try { term.refresh(0, term.rows - 1); } catch (e) {}
    }
    selectionOverlay.classList.remove('active');
    notify({ type: 'set-select-mode', enabled: false });
  }

  function enterSelect(col, absRow) {
    selMode = 'select';
    seedWordSelection(col, absRow);
    selectionOverlay.classList.add('active');
    notify({ type: 'set-select-mode', enabled: true });
    notify({ type: 'haptic', kind: 'selection' });
    repositionOverlay();
  }

  function repositionOverlay() {
    if (selMode !== 'select' || !sel || !term) return;
    var r = selRange();
    var sPx = cellToViewportPx(r.start.col, r.start.row);
    var ePx = cellToViewportPx(r.end.col + 1, r.end.row);
    var cellH = getCellHeight() * getTotalScale();
    // Why: native iOS pattern — start handle anchors at the TOP of the
    // first selected cell (dot above, stem covers the cell going down);
    // end handle anchors at the BOTTOM of the last selected cell (dot
    // below, stem covers the cell going up).
    handleStart.style.left = sPx.x + 'px';
    handleStart.style.top = sPx.y + 'px';
    handleEnd.style.left = ePx.x + 'px';
    handleEnd.style.top = (ePx.y + cellH) + 'px';
    var startVisible = sPx.y >= 0 && sPx.y <= window.innerHeight;
    var endVisible = ePx.y >= 0 && ePx.y <= window.innerHeight;
    handleStart.style.visibility = startVisible ? 'visible' : 'hidden';
    handleEnd.style.visibility = endVisible ? 'visible' : 'hidden';
    var menuCenterX, menuY, vTransform, marginTop;
    if (startVisible && sPx.y > 56) {
      menuCenterX = sPx.x; menuY = sPx.y;
      vTransform = 'translateY(-100%)';
      marginTop = '-12px';
    } else if (endVisible && ePx.y + cellH + 56 < window.innerHeight) {
      menuCenterX = ePx.x; menuY = ePx.y + cellH;
      vTransform = 'translateY(0)';
      marginTop = '12px';
    } else {
      // selection covers full viewport — pin to visible center
      menuCenterX = window.innerWidth / 2;
      menuY = window.innerHeight / 2;
      vTransform = 'translateY(-50%)';
      marginTop = '0';
    }
    // Why: clamp horizontally so the pill stays fully visible when the
    // selection sits near a screen edge. We position via plain left
    // (no horizontal translate) so the clamp math is straightforward.
    selMenu.style.transform = vTransform;
    selMenu.style.marginTop = marginTop;
    selMenu.style.top = menuY + 'px';
    selMenu.style.left = '0px';
    var EDGE_MARGIN = 8;
    var menuW = selMenu.offsetWidth || 0;
    var minLeft = EDGE_MARGIN;
    var maxLeft = Math.max(EDGE_MARGIN, window.innerWidth - menuW - EDGE_MARGIN);
    var desiredLeft = menuCenterX - menuW / 2;
    var clampedLeft = Math.max(minLeft, Math.min(maxLeft, desiredLeft));
    selMenu.style.left = clampedLeft + 'px';
  }

  function syncSelectionHandleToViewportPoint(handle, clientX, clientY) {
    var c = viewportToCell(clientX, clientY);
    if (!c || !sel) return false;
    if (handle === 'start') sel.anchor = c;
    else sel.focus = c;
    applyXtermSelection();
    return true;
  }

  function syncEdgeScrollSelectionEndpoint() {
    if (!sel || !sel.activeHandle) return false;
    // Why: WebView may not emit new touchmove events while a handle is held
    // at the edge; resample the stored finger point after each viewport scroll.
    return syncSelectionHandleToViewportPoint(
      sel.activeHandle,
      edgeScrollClientX,
      edgeScrollClientY
    );
  }

  function startEdgeScroll(dir) {
    if (edgeScrollDir === dir) return;
    stopEdgeScroll();
    edgeScrollDir = dir;
    edgeScrollTimer = setInterval(function() {
      if (!term || edgeScrollDir === 0) return;
      var beforeY = term.buffer.active.viewportY;
      term.scrollLines(edgeScrollDir);
      var afterY = term.buffer.active.viewportY;
      if (beforeY === afterY) {
        notify({ type: 'haptic', kind: 'edge-bump' });
        stopEdgeScroll();
        return;
      }
      syncEdgeScrollSelectionEndpoint();
      repositionOverlay();
    }, EDGE_SCROLL_INTERVAL);
  }

  function stopEdgeScroll() {
    if (edgeScrollTimer) {
      clearInterval(edgeScrollTimer);
      edgeScrollTimer = null;
    }
    edgeScrollDir = 0;
  }

  function handleDragMove(handle, clientX, clientY) {
    edgeScrollClientX = clientX;
    edgeScrollClientY = clientY;
    if (!syncSelectionHandleToViewportPoint(handle, clientX, clientY)) return;
    repositionOverlay();
    if (clientY < EDGE_SCROLL_PX) startEdgeScroll(-1);
    else if (clientY > window.innerHeight - EDGE_SCROLL_PX) startEdgeScroll(1);
    else stopEdgeScroll();
  }

  // Latching document-level touch dispatcher: see
  // terminal-webview-tap-dispatch-injected.ts (extracted for max-lines).
  ${TERMINAL_TAP_DISPATCH_JS}

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
          updateTransform();
        }

        var deltaY = ts.lastY - y;
        ts.lastTime = now;
        if (shouldRouteScrollToTerminalInput()) {
          updateTouchVelocity(deltaY, dt);
          resetSmoothScrollOffset();
          var effectiveCellH = getCellHeight() * getTotalScale();
          ts.accumDelta += deltaY;
          var lines = Math.trunc(ts.accumDelta / effectiveCellH);
          if (lines !== 0) {
            ts.accumDelta -= lines * effectiveCellH;
            routeScrollLines(lines, x, y);
          }
        } else {
          if (enqueueNormalBufferScrollDelta(deltaY)) {
            updateTouchVelocity(deltaY, dt);
          } else {
            ts.velY = 0;
          }
        }
        ts.lastX = x;
        ts.lastY = y;
      }
    }, { capture: true, passive: false });

    targetSurface.addEventListener('touchend', function(e) {
      if (dispatcherShouldBlockSurface()) return;
      if (!term) return;

      if (ts.isPinching && e.touches.length < 2) {
        ts.isPinching = false;
        // Why: a finished pinch snaps to the nearest preset and becomes the new
        // font size (reflowing the grid), so pinch-to-zoom IS the in-terminal way
        // to set the text size. The CSS pinch zoom (userScale) is reset; the real
        // size change reflows columns and RN persists + resizes the PTY to match.
        var target = snapToTextScalePreset(currentTextScale * userScale);
        var changed = target !== currentTextScale;
        userScale = 1;
        panX = 0; panY = 0;
        applyTextScale(target);
        updateTransform();
        notify({ type: 'font-scale-changed', fontScale: target });
        if (changed) notify({ type: 'haptic', kind: 'selection' });
        if (e.touches.length === 1) {
          ts.lastX = e.touches[0].clientX;
          ts.lastY = e.touches[0].clientY;
          ts.lastTime = Date.now();
          ts.velY = 0;
          ts.accumDelta = 0;
        }
        return;
      }

      if (e.touches.length === 0) {
        var vel = ts.velY;
        var FRICTION = 0.972;
        var MIN_VEL = 0.012;
        function momentumStep() {
          vel *= FRICTION;
          if (Math.abs(vel) < MIN_VEL) { ts.momentumId = null; return; }
          var delta = vel * 16;
          if (shouldRouteScrollToTerminalInput()) {
            resetSmoothScrollOffset();
            var effectiveCellH = getCellHeight() * getTotalScale();
            ts.accumDelta += delta;
            var lines = Math.trunc(ts.accumDelta / effectiveCellH);
            if (lines !== 0) {
              ts.accumDelta -= lines * effectiveCellH;
              routeScrollLines(lines, ts.lastX, ts.lastY);
            }
          } else {
            if (!applyNormalBufferScrollDelta(delta)) {
              ts.momentumId = null;
              return;
            }
          }
          ts.momentumId = requestAnimationFrame(momentumStep);
        }
        if (Math.abs(vel) > MIN_VEL) {
          ts.momentumId = requestAnimationFrame(momentumStep);
        }
      }
    }, { capture: true, passive: true });
  }

  attachSurfaceEventHandlers(surface);

  function handleIncomingMessage(e) {
    var msg;
    try {
      msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    } catch (ex) {
      return;
    }
    try {
      handleMsg(msg);
    } catch(ex) {
      reportEngineError(
        msg && msg.type === 'init' ? 'terminal init failed' : 'terminal message failed',
        ex,
        msg && msg.type === 'init' && !everReady
      );
    }
  }

  window.addEventListener('message', handleIncomingMessage);

  document.addEventListener('message', handleIncomingMessage);

  window.addEventListener('resize', function() {
    // Why: viewport changed (keyboard open/close, orientation, RN container
    // size update). Re-fit so the scale matches the new vpWidth — without
    // this, opening the keyboard leaves the terminal at the old scale even
    // though there's now less vertical room and the fit ratio may differ.
    applyFitScale('window-resize');
    adjustRowsForViewport();
    repositionOverlay();
    clampPan();
    updateTransform();
  });

  if (window.Terminal) {
    notify({ type: 'web-ready' });
  } else {
    reportEngineError('terminal engine missing', 'xterm failed to load', true);
  }
})();
</script>
</body>
</html>`

// Why: some WebViews treat source identity as page identity; keep this stable so re-renders don't reload xterm.
export const XTERM_WEBVIEW_SOURCE = { html: XTERM_HTML }
