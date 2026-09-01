import { TERMINAL_KEYBOARD_AVOIDANCE_METRICS_JS } from '../terminal-keyboard-avoidance-metrics-injected'
import { TERMINAL_MOUSE_REPORT_CELL_JS } from '../terminal-webview-mouse-report-cell-injected'

export const TERMINAL_HTML_FRAGMENT_06 = `  var linesEverWritten = 0;

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

  ${TERMINAL_MOUSE_REPORT_CELL_JS}

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
`
