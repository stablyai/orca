import { TERMINAL_MOUSE_REPORT_CELL_JS } from '../terminal-webview-mouse-report-cell-injected'

export const TERMINAL_HTML_MOUSE_REPORT_AND_SCROLL_ROUTING = `  function viewportToCell(clientX, clientY) {
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

`
