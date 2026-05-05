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

  function computeFitScale() {
    if (!term) return 1;
    var el = term.element;
    if (!el) return 1;
    var termWidth = el.scrollWidth;
    var vpWidth = window.innerWidth;
    if (termWidth <= 0) return 1;
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

  // Why: on cold start (first WebView load + first scrollback) xterm's DOM
  // and canvas need several frames to reflow after term.open(). If we
  // computeFitScale() too eagerly we read scrollWidth=0 or a stale width
  // from before the new cols took effect, scrollWidth/vpWidth >= 1, and
  // currentScale snaps to 1 — which is exactly the "didn't zoom to fit"
  // bug users see on first load. Retry across frames until we get a
  // positive, stable scrollWidth, then commit. Capped to keep this from
  // spinning forever if the WebView never lays out (e.g. backgrounded).
  var FIT_RETRY_MAX_FRAMES = 30;
  var fitRetryToken = 0;
  function applyFitScale() {
    if (!term || !term.element) return;
    var token = ++fitRetryToken;
    var attempts = 0;
    var lastWidth = -1;
    function attempt() {
      if (token !== fitRetryToken) return;
      if (!term || !term.element) return;
      var w = term.element.scrollWidth;
      attempts++;
      if (w > 0 && w === lastWidth) {
        commitFitScale();
        return;
      }
      lastWidth = w;
      if (attempts >= FIT_RETRY_MAX_FRAMES) {
        commitFitScale();
        return;
      }
      requestAnimationFrame(attempt);
    }
    requestAnimationFrame(attempt);
  }

  function commitFitScale() {
    if (!term || !term.element) return;
    currentScale = computeFitScale();
    // Why: when the scale is very close to 1 (e.g. 0.97 due to xterm
    // scrollbar width), snap to 1.0 to avoid sub-pixel shrinkage.
    if (currentScale >= 0.95) currentScale = 1;
    userScale = 1;
    panX = 0;
    panY = 0;
    updateTransform();
    adjustRowsForViewport();
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
        applyFitScale();
        notify({ type: 'ready', cols: cols, rows: rows });
      });
    });
  }

  function write(data) {
    writeQueue.push(data);
    pumpWrites(terminalGeneration);
  }

  function notify(msg) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(msg));
    }
  }

  function measureFitDimensions(containerHeightPx) {
    if (!term || !term.element) {
      notify({ type: 'measure-result', cols: null, rows: null });
      return;
    }
    // Why: measure actual xterm cell dimensions from the renderer, not from
    // font metrics alone. This accounts for the exact font, size, and line
    // height that xterm is using.
    var core = term._core;
    var cellWidth = 0;
    var cellHeight = 0;
    if (core && core._renderService && core._renderService.dimensions) {
      cellWidth = core._renderService.dimensions.css.cell.width;
      cellHeight = core._renderService.dimensions.css.cell.height;
    }
    if (cellWidth <= 0 || cellHeight <= 0) {
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
    // Why: subtract 2 rows after dividing. The WebView's reported height
    // can slightly overstate the usable area (layout timing, subpixel
    // rounding, safe-area insets). Subtracting 2 guarantees the last
    // visible row plus the shell prompt (which often wraps on narrow
    // screens) stays fully above the accessory bar.
    var rows = Math.max(8, Math.floor(vpHeight / cellHeight) - 2);
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
      applyFitScale();
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
      } else if (msg.type === 'measure-result') {
        const resolve = measureResolveRef.current
        measureResolveRef.current = null
        if (resolve) {
          const cols = typeof msg.cols === 'number' ? msg.cols : null
          const rows = typeof msg.rows === 'number' ? msg.rows : null
          resolve(cols && rows && cols >= 20 && rows >= 8 ? { cols, rows } : null)
        }
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
