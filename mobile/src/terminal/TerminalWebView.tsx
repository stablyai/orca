import { useRef, useCallback, forwardRef, useImperativeHandle } from 'react'
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native'
import { WebView } from 'react-native-webview'
import type { WebViewMessageEvent } from 'react-native-webview'
import { colors } from '../theme/mobile-theme'

export type TerminalWebViewHandle = {
  write: (data: string) => void
  init: (cols: number, rows: number, initialData?: string) => void
  clear: () => void
  measureFitDimensions: (containerHeight?: number) => Promise<{ cols: number; rows: number } | null>
  resetZoom: () => void
  // Why: lets callers await the WebView-side `init` rAF chain (term.open
  // → renderService population → first paint) so a follow-up measure
  // doesn't race ahead and find term=null or cellWidth=0. Resolves on
  // the next 'ready' notify after the most recent init.
  awaitReady: () => Promise<void>
}

type Props = {
  style?: StyleProp<ViewStyle>
  onWebReady?: () => void
}

type TerminalMessage =
  | { type: 'write'; id?: number; data: string }
  | { type: 'init'; id?: number; cols: number; rows: number; initialData?: string }
  | { type: 'clear'; id?: number }
  | { type: 'measure'; id?: number; containerHeight?: number }
  | { type: 'reset-zoom'; id?: number }

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
</style>
</head>
<body>
<div id="terminal-container">
  <div id="terminal-surface"></div>
</div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@6.1.0-beta.198/lib/xterm.min.js"></script>
<script>
(function() {
  var surface = document.getElementById('terminal-surface');
  var ESC = String.fromCharCode(27);
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
    if (!term || !term.element) {
      flog('skip-no-term', { reason: reason });
      return;
    }
    var token = ++fitRetryToken;
    var attempts = 0;
    var lastScrollWidth = -1;
    flog('start', {
      reason: reason,
      cols: term.cols,
      rows: term.rows,
      vpWidth: window.innerWidth,
      vpHeight: window.innerHeight
    });
    function attempt() {
      if (token !== fitRetryToken) {
        flog('cancel-superseded', { reason: reason, attempts: attempts });
        return;
      }
      if (!term || !term.element) return;
      attempts++;
      var cellW = getCellWidth();
      if (cellW > 0 && term.cols > 0) {
        flog('commit-cellW', { reason: reason, attempts: attempts, cellW: cellW, cols: term.cols });
        commitFitScale(reason, attempts, 'cellW');
        return;
      }
      var w = term.element.scrollWidth;
      if (w > 0 && w === lastScrollWidth) {
        flog('commit-stableSW', { reason: reason, attempts: attempts, scrollWidth: w });
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
    flog(suspect ? 'commit-SUSPECT' : 'commit', {
      reason: reason,
      attempts: attempts,
      gate: gate,
      preSnapScale: preSnapScale,
      finalScale: currentScale,
      cellW: cellW,
      cols: term.cols,
      expectedW: expectedW,
      scrollWidth: sw,
      vpWidth: vpW,
      suspect: suspect
    });
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
    flog('init', {
      cols: cols,
      rows: rows,
      hasInitialData: typeof initialData === 'string' && initialData.length > 0,
      initialDataLen: typeof initialData === 'string' ? initialData.length : 0,
      vpWidth: window.innerWidth,
      vpHeight: window.innerHeight,
      gen: gen
    });
    var replayData = normalizeInitialData(initialData);
    activeAltScreenSnapshot = isAltScreenActive(replayData);
    if (term) term.dispose();

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

    requestAnimationFrame(function() {
      if (gen !== terminalGeneration) return;
      ready = true;
      afterWritesDrained(function() {
        if (gen !== terminalGeneration) return;
        applyFitScale('init-replay');
        notify({ type: 'ready', cols: cols, rows: rows });
      });
    });
  }

  function write(data) {
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
    } else if (msg.type === 'write') {
      write(msg.data);
    } else if (msg.type === 'clear') {
      terminalGeneration++;
      writeQueue = [];
      afterDrainCallbacks = [];
      writesDraining = false;
      if (term) { term.clear(); term.reset(); }
    } else if (msg.type === 'measure') {
      measureFitDimensions(msg.containerHeight);
    } else if (msg.type === 'reset-zoom') {
      applyFitScale('reset-zoom-msg');
    }
  }

  // Why: event listeners are registered once here (not inside init()) so
  // they don't accumulate on re-init. They close over the mutable 'term'
  // variable, so they always reference the current terminal instance.
  surface.addEventListener('mousedown', function(e) { e.preventDefault(); e.stopPropagation(); }, true);
  surface.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); }, true);

  var ts = {
    lastX: 0, lastY: 0, lastTime: 0, velY: 0,
    accumDelta: 0, momentumId: null, isPinching: false,
    pinchDist: 0, pinchScale: 0, pinchSurfX: 0, pinchSurfY: 0
  };

  function getDistance(a, b) {
    var dx = a.clientX - b.clientX, dy = a.clientY - b.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  surface.addEventListener('touchstart', function(e) {
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

  surface.addEventListener('touchmove', function(e) {
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
          term.scrollLines(lines);
        }
      }
      ts.lastX = x;
      ts.lastY = y;
    }
  }, { capture: true, passive: false });

  surface.addEventListener('touchend', function(e) {
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
          term.scrollLines(lines);
        }
        ts.momentumId = requestAnimationFrame(momentumStep);
      }
      if (Math.abs(vel) > MIN_VEL) {
        ts.momentumId = requestAnimationFrame(momentumStep);
      }
    }
  }, { capture: true, passive: true });

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
  { style, onWebReady },
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
      }
    },
    [flushPendingMessages, onWebReady]
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
        // Re-init supersedes any prior in-flight ready (we don't bridge
        // generations; the older promise just never resolves, and its
        // callers have moved on by then).
        readyPromiseRef.current = new Promise<void>((resolve) => {
          readyResolveRef.current = resolve
        })
        postMessage({ type: 'init', cols, rows, initialData })
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
