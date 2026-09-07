import { TERMINAL_WEBGL_RECOVERY_JS } from '../terminal-webview-webgl-recovery-injected'
import { MOBILE_TERMINAL_CARET_OPTIONS } from './theme'

export const TERMINAL_HTML_INIT_AND_WRITE = `${TERMINAL_WEBGL_RECOVERY_JS}

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
    wheelAccumDeltaY = 0;
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
      cursorBlink: ${MOBILE_TERMINAL_CARET_OPTIONS.cursorBlink},
      cursorStyle: ${JSON.stringify(MOBILE_TERMINAL_CARET_OPTIONS.cursorStyle)},
      // Native TextInput owns focus; initialize xterm's otherwise-gated main-buffer caret.
      showCursorImmediately: ${MOBILE_TERMINAL_CARET_OPTIONS.showCursorImmediately},
      // A full inactive cell remains visible under the terminal's phone-fit scale.
      cursorInactiveStyle: ${JSON.stringify(MOBILE_TERMINAL_CARET_OPTIONS.cursorInactiveStyle)},
      convertEol: false,
      allowProposedApi: true
    });
    var nextTerm = term;
    pendingTerm = nextTerm;
    term.open(surface);
    attachWebglAddon(true);
    if (window.Unicode11Addon && window.Unicode11Addon.Unicode11Addon) try { term.loadAddon(new window.Unicode11Addon.Unicode11Addon()); term.unicode.activeVersion = '11'; } catch (e) {}
    if (typeof replayData === 'string' && replayData.length > 0) {
      // Why no trailing reset: the snapshot pen belongs to the live host TUI receiving later output.
      enqueueWrite(ESC + '[0m' + replayData);
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
    emitKeyboardAvoidanceMetrics();
    applyFitScale('resize-msg');
    notify({ type: 'ready', cols: cols, rows: rows });
  }

  // reflow(): see terminal-webview-reflow-injected.ts (extracted for max-lines).
`
