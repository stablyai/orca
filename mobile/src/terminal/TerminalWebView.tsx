import { useRef, useCallback, forwardRef, useImperativeHandle } from 'react'
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native'
import { WebView } from 'react-native-webview'
import type { WebViewMessageEvent } from 'react-native-webview'
import { colors } from '../theme/mobile-theme'

type TerminalMouseTrackingMode = 'none' | 'x10' | 'vt200' | 'drag' | 'any'

export type TerminalModes = {
  bracketedPasteMode: boolean
  altScreen: boolean
  mouseTrackingMode: TerminalMouseTrackingMode
  sgrMouseMode: boolean
  sgrMousePixelsMode: boolean
}

export type TerminalKeyboardAvoidanceMetrics = {
  cursorY: number
  rows: number
  altScreen: boolean
}

export type TerminalSelectionEvents = {
  onSelectionMode?: (active: boolean) => void
  onSelectionCopy?: (text: string) => void
  onSelectionEvicted?: () => void
  onModesChanged?: (modes: TerminalModes) => void
  onKeyboardAvoidanceMetrics?: (metrics: TerminalKeyboardAvoidanceMetrics) => void
  onHaptic?: (kind: 'selection' | 'success' | 'error' | 'edge-bump') => void
  onTerminalInput?: (bytes: string) => void
}

export type TerminalWebViewHandle = {
  write: (data: string) => void
  init: (cols: number, rows: number, initialData?: string) => void
  resize: (cols: number, rows: number) => void
  clear: () => void
  measureFitDimensions: (containerHeight?: number) => Promise<{ cols: number; rows: number } | null>
  resetZoom: () => void
  cancelSelect: () => void
  doSelectAll: () => void
  // Why: lets callers await the WebView-side `init` rAF chain (term.open
  // → renderService population → first paint) so a follow-up measure
  // doesn't race ahead and find term=null or cellWidth=0. Resolves on
  // the next 'ready' notify after the most recent init.
  awaitReady: () => Promise<void>
}

type Props = {
  style?: StyleProp<ViewStyle>
  onWebReady?: () => void
} & TerminalSelectionEvents

type TerminalMessage =
  | { type: 'write'; id?: number; data: string }
  | { type: 'init'; id?: number; cols: number; rows: number; initialData?: string }
  | { type: 'resize'; id?: number; cols: number; rows: number }
  | { type: 'clear'; id?: number }
  | { type: 'measure'; id?: number; containerHeight?: number }
  | { type: 'reset-zoom'; id?: number }
  | { type: 'cancel-select'; id?: number }
  | { type: 'do-select-all'; id?: number }

// Why: TUI apps (Claude Code / Ink) emit escape codes with absolute cursor
// positioning designed for the desktop's terminal dimensions (~150+ cols).
// We initialize xterm at the desktop's exact cols/rows so those escape codes
// render correctly, then use a measured CSS transform: scale() to fit the
// canvas into the phone viewport. The scale is computed after xterm opens
// by measuring the rendered surface width, not hardcoded, so it adapts to
// any terminal column count (80, 150, 200+). All touch gestures (scroll,
// pinch-to-zoom, pan) are handled by custom JS rather than native WebView
// behavior, so they work correctly with the CSS scale transform.
const XTERM_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@6.1.0-beta.198/css/xterm.min.css">
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
  .xterm { -webkit-user-select: none; user-select: none; }
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
<div id="selection-overlay">
  <div id="sel-handle-start" class="sel-handle start"></div>
  <div id="sel-handle-end" class="sel-handle end"></div>
  <div id="sel-menu">
    <button id="sel-menu-copy">Copy</button>
    <button id="sel-menu-all">Select All</button>
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@6.1.0-beta.198/lib/xterm.min.js"></script>
<script>
(function() {
  var surface = document.getElementById('terminal-surface');
  var ESC = String.fromCharCode(27);
  var C1_CSI = String.fromCharCode(155);
  var PRIVATE_MODE_SCAN_TAIL_LIMIT = 4096;
  var term = null;
  var writeQueue = [];
  var writesDraining = false;
  var afterDrainCallbacks = [];
  var ready = false;
  var currentScale = 1;
  var userScale = 1;
  var panX = 0;
  var panY = 0;
  var initRows = 24;
  var terminalGeneration = 0;
  var activeAltScreenSnapshot = false;
  var trackedMouseTrackingMode = 'none';
  var sgrMouseMode = false;
  var sgrMousePixelsMode = false;
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
    if (selMode === 'select') repositionOverlay();
  }

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

  // Why: the desktop terminal may have fewer rows than needed to fill
  // the phone's WebView at the current scale (e.g. 40 desktop rows
  // scaled to 0.3x only covers ~40% of the viewport). Resize xterm's
  // viewport to fill the available height so there's no blank gap
  // below the last terminal line. This is display-only — the PTY is
  // not resized — so the extra rows just show empty terminal background
  // managed by xterm, not a separate HTML gap. Never shrink below the
  // original init row count to avoid clipping active terminal content.
  function adjustRowsForViewport() {
    // Why: mobile replays a live PTY snapshot and then applies live cursor-
    // relative chunks from that same PTY. Resizing only the WebView xterm
    // changes cursor coordinates and makes TUI repaint chunks duplicate or
    // overlap existing frames. Keep xterm rows identical to the PTY.
    return;
    if (!term || !term.element) return;
    // Why: active alternate-screen TUIs (Claude Code, vim, etc.) are exact
    // screen snapshots. Locally resizing the mobile xterm after replay can
    // mutate the alt buffer and drop cell attributes, which shows as white text.
    if (activeAltScreenSnapshot) return;
    var cellHeight = getCellHeight();
    if (cellHeight > 0 && currentScale > 0) {
      var vpHeight = window.innerHeight;
      var neededRows = Math.floor(vpHeight / (cellHeight * currentScale));
      if (neededRows >= initRows && neededRows !== term.rows) {
        term.resize(term.cols, neededRows);
      }
    }
  }

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
    var next = writeQueue.shift();
    if (typeof next !== 'string') {
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

  function init(cols, rows, initialData) {
    terminalGeneration++;
    var gen = terminalGeneration;
    ready = false;
    writeQueue = [];
    writesDraining = false;
    afterDrainCallbacks = [];
    initRows = rows || 24;
    firstDataPending = true;
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
    var oldTerm = term;
    var oldSurface = surface;
    var nextSurface = null;
    if (oldTerm) {
      nextSurface = document.createElement('div');
      nextSurface.id = 'terminal-surface';
      nextSurface.style.visibility = 'hidden';
      nextSurface.style.position = 'absolute';
      nextSurface.style.left = '0';
      nextSurface.style.top = '0';
      document.getElementById('terminal-container').appendChild(nextSurface);
      surface = nextSurface;
      attachSurfaceEventHandlers(surface);
      oldSurface.removeAttribute('id');
    }

    term = new Terminal({
      cols: cols || 80,
      rows: rows || 24,
      theme: {
        background: '${colors.terminalBg}',
        foreground: '#c0caf5',
        cursor: '#c0caf5',
        cursorAccent: '${colors.terminalBg}',
        selectionBackground: '#33467c',
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
      },
      fontFamily: '"Menlo", "Consolas", "DejaVu Sans Mono", monospace',
      fontSize: 13,
      scrollback: 5000,
      disableStdin: true,
      cursorBlink: false,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      convertEol: false,
      allowProposedApi: true
    });
    term.open(surface);
    if (typeof replayData === 'string' && replayData.length > 0) {
      writeQueue.push(replayData);
    }

    // Why: reset eviction tracking + attach observers for the new term.
    resetEvictionCounter();
    cancelSelect();
    attachTermObservers();

    requestAnimationFrame(function() {
      if (gen !== terminalGeneration) return;
      ready = true;
      afterWritesDrained(function() {
        if (gen !== terminalGeneration) return;
        if (nextSurface && oldSurface) {
          nextSurface.style.visibility = 'visible';
          nextSurface.style.position = '';
          nextSurface.style.left = '';
          nextSurface.style.top = '';
          oldSurface.remove();
          if (oldTerm) oldTerm.dispose();
        }
        applyFitScale('init-replay');
        notify({ type: 'ready', cols: cols, rows: rows });
      });
    });
  }

  function write(data) {
    updateMouseModeFromData(data);
    writeQueue.push(data);
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

  function notify(msg) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(msg));
    }
  }

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
    if (msg.type === 'init') {
      init(msg.cols, msg.rows, msg.initialData);
    } else if (msg.type === 'resize') {
      resize(msg.cols, msg.rows);
    } else if (msg.type === 'write') {
      write(msg.data);
    } else if (msg.type === 'clear') {
      terminalGeneration++;
      writeQueue = [];
      afterDrainCallbacks = [];
      writesDraining = false;
      mouseModeScanTail = '';
      trackedMouseTrackingMode = 'none';
      sgrMouseMode = false;
      sgrMousePixelsMode = false;
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
  var edgeScrollTimer = null;
  var edgeScrollDir = 0;

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
    try { term.onLineFeed(logFeedAndEvict); } catch (e) {}
    // Why: emit modes on every parsed write so RN's mirror stays current
    // without round-trip; covers \\x1b[?2004h/l and alt-screen toggles.
    try {
      term.onWriteParsed && term.onWriteParsed(function() {
        emitModesIfChanged();
        emitKeyboardAvoidanceMetrics();
      });
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
      return ESC + '[<' + eventCode + ';' + cell.x + ';' + cell.y + 'M';
    }
    if (sgrMouseMode) {
      // Why: xterm increments zero-based mouse cells before encoding reports.
      return ESC + '[<' + eventCode + ';' + (cell.col + 1) + ';' + (cell.row + 1) + 'M';
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

  function isWheelMouseTrackingMode(mode) {
    return mode !== 'none' && mode !== 'x10';
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

  function startEdgeScroll(dir) {
    if (edgeScrollDir === dir) return;
    edgeScrollDir = dir;
    stopEdgeScroll();
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
    var c = viewportToCell(clientX, clientY);
    if (!c || !sel) return;
    if (handle === 'start') sel.anchor = c;
    else sel.focus = c;
    applyXtermSelection();
    repositionOverlay();
    if (clientY < EDGE_SCROLL_PX) startEdgeScroll(-1);
    else if (clientY > window.innerHeight - EDGE_SCROLL_PX) startEdgeScroll(1);
    else stopEdgeScroll();
  }

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
      clearLongPress();
      if (e.touches.length === 0) {
        dispatch.mode = 'idle';
        dispatch.touchId = null;
      }
    }
  }, { capture: true, passive: true });

  document.addEventListener('touchcancel', function() {
    clearLongPress();
    stopEdgeScroll();
    if (dispatch.mode === 'select-drag') {
      if (sel) sel.activeHandle = null;
    }
    dispatch.mode = 'idle';
    dispatch.touchId = null;
    dispatch.touchIds = null;
  }, { capture: true, passive: true });

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
        userScale = Math.max(1, Math.min(5, ts.pinchScale * ratio));

        var total = getTotalScale();
        panX = mx - ts.pinchSurfX * total;
        panY = my - ts.pinchSurfY * total;
        clampPan();
        updateTransform();

      } else if (e.touches.length === 1 && !ts.isPinching) {
        var x = e.touches[0].clientX;
        var y = e.touches[0].clientY;
        var now = Date.now();
        var dt = now - ts.lastTime;

        if (userScale > 1.05) {
          panX += x - ts.lastX;
          panY += y - ts.lastY;
          clampPan();
          updateTransform();
        } else {
          var deltaY = ts.lastY - y;
          if (dt > 0) ts.velY = deltaY / dt;
          ts.lastTime = now;
          var effectiveCellH = getCellHeight() * currentScale;
          ts.accumDelta += deltaY;
          var lines = Math.trunc(ts.accumDelta / effectiveCellH);
          if (lines !== 0) {
            ts.accumDelta -= lines * effectiveCellH;
            routeScrollLines(lines, x, y);
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
        if (userScale < 1.15) {
          userScale = 1; panX = 0; panY = 0;
          updateTransform();
        }
        if (e.touches.length === 1) {
          ts.lastX = e.touches[0].clientX;
          ts.lastY = e.touches[0].clientY;
          ts.lastTime = Date.now();
          ts.velY = 0;
          ts.accumDelta = 0;
        }
        return;
      }

      if (e.touches.length === 0 && userScale <= 1.05) {
        var vel = ts.velY;
        var FRICTION = 0.95;
        var MIN_VEL = 0.02;
        function momentumStep() {
          vel *= FRICTION;
          if (Math.abs(vel) < MIN_VEL) { ts.momentumId = null; return; }
          var effectiveCellH = getCellHeight() * currentScale;
          ts.accumDelta += vel * 16;
          var lines = Math.trunc(ts.accumDelta / effectiveCellH);
          if (lines !== 0) {
            ts.accumDelta -= lines * effectiveCellH;
            routeScrollLines(lines, ts.lastX, ts.lastY);
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

  window.addEventListener('message', function(e) {
    try {
      handleMsg(typeof e.data === 'string' ? JSON.parse(e.data) : e.data);
    } catch(ex) {}
  });

  document.addEventListener('message', function(e) {
    try {
      handleMsg(typeof e.data === 'string' ? JSON.parse(e.data) : e.data);
    } catch(ex) {}
  });

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
    notify({ type: 'error', message: 'xterm failed to load' });
  }
})();
</script>
</body>
</html>`

export const TerminalWebView = forwardRef<TerminalWebViewHandle, Props>(function TerminalWebView(
  {
    style,
    onWebReady,
    onSelectionMode,
    onSelectionCopy,
    onSelectionEvicted,
    onModesChanged,
    onKeyboardAvoidanceMetrics,
    onHaptic,
    onTerminalInput
  },
  ref
) {
  const webViewRef = useRef<WebView>(null)
  const isWebReadyRef = useRef(false)
  const pendingMessagesRef = useRef<TerminalMessage[]>([])
  const messageIdRef = useRef(0)
  const measureResolveRef = useRef<
    ((result: { cols: number; rows: number } | null) => void) | null
  >(null)
  // Why: each init() call posts 'init' to the WebView and arms a fresh
  // ready promise. WebView's init() rAF chain ends with a 'ready' notify
  // that resolves it. measureFitDimensions awaits this so it doesn't
  // race ahead of term.open() / renderService population.
  const readyPromiseRef = useRef<Promise<void> | null>(null)
  const readyResolveRef = useRef<(() => void) | null>(null)

  const sendToWebView = useCallback((msg: TerminalMessage) => {
    messageIdRef.current += 1
    webViewRef.current?.postMessage(JSON.stringify({ ...msg, id: messageIdRef.current }))
  }, [])

  const flushPendingMessages = useCallback(() => {
    const pending = pendingMessagesRef.current
    pendingMessagesRef.current = []
    for (const msg of pending) {
      sendToWebView(msg)
    }
  }, [sendToWebView])

  const postMessage = useCallback(
    (msg: TerminalMessage) => {
      if (!isWebReadyRef.current) {
        pendingMessagesRef.current.push(msg)
        return
      }
      sendToWebView(msg)
    },
    [sendToWebView]
  )

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(event.nativeEvent.data) as Record<string, unknown>
      } catch {
        return
      }

      if (msg.type === 'web-ready') {
        isWebReadyRef.current = true
        onWebReady?.()
        flushPendingMessages()
      } else if (msg.type === 'ready') {
        // Why: the WebView's init() rAF chain has run — term is open,
        // renderService is populated, first paint has happened. Resolve
        // any pending awaitReady() so a queued measure can now safely
        // read cell dims.
        const resolve = readyResolveRef.current
        readyResolveRef.current = null
        readyPromiseRef.current = null
        resolve?.()
      } else if (msg.type === 'measure-result') {
        const resolve = measureResolveRef.current
        measureResolveRef.current = null
        if (resolve) {
          const cols = typeof msg.cols === 'number' ? msg.cols : null
          const rows = typeof msg.rows === 'number' ? msg.rows : null
          resolve(cols && rows && cols >= 20 && rows >= 8 ? { cols, rows } : null)
        }
      } else if (msg.type === 'log') {
        // Surface fit-scale diagnostics in the RN/Metro console.
        const tag = typeof msg.tag === 'string' ? msg.tag : '[fit]'
        // eslint-disable-next-line no-console
        console.log(tag, msg.payload)
      } else if (msg.type === 'set-select-mode') {
        onSelectionMode?.(!!msg.enabled)
      } else if (msg.type === 'selection') {
        const text = typeof msg.text === 'string' ? msg.text : ''
        onSelectionCopy?.(text)
      } else if (msg.type === 'selection-evicted') {
        onSelectionEvicted?.()
      } else if (msg.type === 'modes') {
        const mouseTrackingMode =
          msg.mouseTrackingMode === 'x10' ||
          msg.mouseTrackingMode === 'vt200' ||
          msg.mouseTrackingMode === 'drag' ||
          msg.mouseTrackingMode === 'any'
            ? msg.mouseTrackingMode
            : 'none'
        onModesChanged?.({
          bracketedPasteMode: !!msg.bracketedPasteMode,
          altScreen: !!msg.altScreen,
          mouseTrackingMode,
          sgrMouseMode: !!msg.sgrMouseMode,
          sgrMousePixelsMode: !!msg.sgrMousePixelsMode
        })
      } else if (msg.type === 'terminal-input') {
        const bytes = typeof msg.bytes === 'string' ? msg.bytes : ''
        if (bytes.length > 0) onTerminalInput?.(bytes)
      } else if (msg.type === 'keyboard-avoidance-metrics') {
        const cursorY = typeof msg.cursorY === 'number' ? msg.cursorY : 0
        const rows = typeof msg.rows === 'number' ? msg.rows : 0
        onKeyboardAvoidanceMetrics?.({
          cursorY,
          rows,
          altScreen: !!msg.altScreen
        })
      } else if (msg.type === 'haptic') {
        const kind = msg.kind
        if (
          kind === 'selection' ||
          kind === 'success' ||
          kind === 'error' ||
          kind === 'edge-bump'
        ) {
          onHaptic?.(kind)
        }
      } else if (msg.type === 'mobile-clip-cancel-by-pinch') {
        // eslint-disable-next-line no-console
        console.warn('[mobile-clip] selection cancelled by pinch')
      }
    },
    [
      flushPendingMessages,
      onWebReady,
      onSelectionMode,
      onSelectionCopy,
      onSelectionEvicted,
      onModesChanged,
      onKeyboardAvoidanceMetrics,
      onHaptic,
      onTerminalInput
    ]
  )

  const handleLoadStart = useCallback(() => {
    isWebReadyRef.current = false
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      write(data: string) {
        postMessage({ type: 'write', data })
      },
      init(cols: number, rows: number, initialData?: string) {
        // Why: arm a fresh ready promise BEFORE posting init. The WebView
        // resolves it via the 'ready' notify at the end of its rAF chain.
        // Resolve any prior in-flight ready first so awaiters from the
        // previous generation don't sit on the 3s setTimeout fallback —
        // each leaked timer + closure pinned an awaiting measure caller
        // for the full 3s under rapid re-init (orientation change,
        // multiple resubscribes), delaying cold-start fit chains.
        const priorResolve = readyResolveRef.current
        if (priorResolve) {
          readyResolveRef.current = null
          readyPromiseRef.current = null
          priorResolve()
        }
        readyPromiseRef.current = new Promise<void>((resolve) => {
          readyResolveRef.current = resolve
        })
        postMessage({ type: 'init', cols, rows, initialData })
      },
      resize(cols: number, rows: number) {
        postMessage({ type: 'resize', cols, rows })
      },
      clear() {
        postMessage({ type: 'clear' })
      },
      measureFitDimensions(
        containerHeight?: number
      ): Promise<{ cols: number; rows: number } | null> {
        if (!isWebReadyRef.current) return Promise.resolve(null)
        return new Promise((resolve) => {
          measureResolveRef.current?.(null)
          measureResolveRef.current = resolve
          sendToWebView({ type: 'measure', containerHeight })
          // Why: if the WebView doesn't respond within 2s (e.g., xterm
          // failed to load), resolve null so the caller can disable
          // Fit to Phone rather than hanging indefinitely.
          setTimeout(() => {
            if (measureResolveRef.current === resolve) {
              measureResolveRef.current = null
              resolve(null)
            }
          }, 2000)
        })
      },
      resetZoom() {
        postMessage({ type: 'reset-zoom' })
      },
      cancelSelect() {
        postMessage({ type: 'cancel-select' })
      },
      doSelectAll() {
        postMessage({ type: 'do-select-all' })
      },
      async awaitReady(): Promise<void> {
        // Why: returns the in-flight ready promise (set by init); resolves
        // immediately if no init is pending. Capped at 3s so a stuck
        // WebView doesn't hang the caller.
        const p = readyPromiseRef.current
        if (!p) return
        await Promise.race([p, new Promise<void>((resolve) => setTimeout(resolve, 3000))])
      }
    }),
    [postMessage, sendToWebView]
  )

  return (
    <WebView
      ref={webViewRef}
      source={{ html: XTERM_HTML }}
      style={[styles.webview, style]}
      originWhitelist={['*']}
      javaScriptEnabled
      scrollEnabled={true}
      scalesPageToFit={false}
      onLoadStart={handleLoadStart}
      onMessage={handleMessage}
    />
  )
})

const styles = StyleSheet.create({
  webview: {
    flex: 1,
    backgroundColor: colors.terminalBg
  }
})
