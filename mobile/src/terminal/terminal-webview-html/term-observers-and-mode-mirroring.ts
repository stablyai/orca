import { TERMINAL_KEYBOARD_AVOIDANCE_METRICS_JS } from '../terminal-keyboard-avoidance-metrics-injected'

export const TERMINAL_HTML_OBSERVERS_AND_MODE_MIRRORING = `  function emitModesIfChanged() {
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

  ${TERMINAL_KEYBOARD_AVOIDANCE_METRICS_JS}

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

`
