import { TERMINAL_REFLOW_JS } from '../terminal-webview-reflow-injected'

export const TERMINAL_HTML_HOST_MESSAGE_ROUTER = `  ${TERMINAL_REFLOW_JS}

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
      emitKeyboardAvoidanceMetrics();
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

`
