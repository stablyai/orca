import { notify } from './host-notify'
import { scope } from './document-scope'
import { viewportToMouseReportCell } from './mouse-report-cell'

export function isAlternateBufferActive() {
  try {
    return !!(
      scope.term &&
      scope.term.buffer &&
      scope.term.buffer.active &&
      scope.term.buffer.active.type === 'alternate'
    )
  } catch {
    return false
  }
}

export function getMouseTrackingMode() {
  try {
    if (scope.term && scope.term.modes && typeof scope.term.modes.mouseTrackingMode === 'string') {
      const mode = scope.term.modes.mouseTrackingMode
      if (mode === 'x10' || mode === 'vt200' || mode === 'drag' || mode === 'any') {
        return mode
      }
      return 'none'
    }
  } catch {}
  if (
    scope.trackedMouseTrackingMode === 'x10' ||
    scope.trackedMouseTrackingMode === 'vt200' ||
    scope.trackedMouseTrackingMode === 'drag' ||
    scope.trackedMouseTrackingMode === 'any'
  ) {
    return scope.trackedMouseTrackingMode
  }
  return 'none'
}

export function repeatSequence(sequence: string, count: number) {
  let out = ''
  for (let i = 0; i < count; i++) {
    out += sequence
  }
  return out
}

export function buildArrowScrollSequence(lines: number) {
  let prefix = '['
  try {
    if (scope.term && scope.term.modes && scope.term.modes.applicationCursorKeysMode) {
      prefix = 'O'
    }
  } catch {}
  return scope.ESC + prefix + (lines < 0 ? 'A' : 'B')
}

export function buildMouseWheelSequence(lines: number, clientX: number, clientY: number) {
  const cell = viewportToMouseReportCell(clientX, clientY)
  if (!cell) {
    return ''
  }
  const eventCode = lines < 0 ? 64 : 65
  if (scope.sgrMousePixelsMode) {
    if (!isSafeSgrMouseCoordinate(cell.x) || !isSafeSgrMouseCoordinate(cell.y)) {
      return ''
    }
    return scope.ESC + '[<' + eventCode + ';' + cell.x + ';' + cell.y + 'M'
  }
  if (scope.sgrMouseMode) {
    // Why: xterm increments zero-based mouse cells before encoding reports.
    const sgrCol = cell.col + 1
    const sgrRow = cell.row + 1
    if (!isSafeSgrMouseCoordinate(sgrCol) || !isSafeSgrMouseCoordinate(sgrRow)) {
      return ''
    }
    return scope.ESC + '[<' + eventCode + ';' + sgrCol + ';' + sgrRow + 'M'
  }
  // Why: xterm increments zero-based mouse cells before encoding reports.
  const button = eventCode + 32
  const col = cell.col + 1 + 32
  const row = cell.row + 1 + 32
  // Why: non-SGR mouse bytes above ASCII are not preserved reliably through
  // the mobile JSON/RPC string path. Fall back to keys for wide terminals.
  if (button > 126 || col > 126 || row > 126) {
    return ''
  }
  return (
    scope.ESC +
    '[M' +
    String.fromCharCode(button) +
    String.fromCharCode(col) +
    String.fromCharCode(row)
  )
}

export function isSafeSgrMouseCoordinate(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= 9999
}

export function buildMouseClickInput(clientX: number, clientY: number) {
  const mouseTrackingMode = getMouseTrackingMode()
  if (!isClickMouseTrackingMode(mouseTrackingMode)) {
    return ''
  }
  const cell = viewportToMouseReportCell(clientX, clientY)
  if (!cell) {
    return ''
  }
  if (scope.sgrMousePixelsMode) {
    // Why: xterm 1016 keeps SGR syntax but reports raw zero-based pixel positions.
    const pixelX = cell.x
    const pixelY = cell.y
    if (!isSafeSgrMouseCoordinate(pixelX) || !isSafeSgrMouseCoordinate(pixelY)) {
      return ''
    }
    const pixelPress = scope.ESC + '[<0;' + pixelX + ';' + pixelY + 'M'
    if (mouseTrackingMode === 'x10') {
      return pixelPress
    }
    return pixelPress + scope.ESC + '[<0;' + pixelX + ';' + pixelY + 'm'
  }
  if (scope.sgrMouseMode) {
    // Why: xterm increments zero-based mouse cells before encoding reports.
    const sgrCol = cell.col + 1
    const sgrRow = cell.row + 1
    if (!isSafeSgrMouseCoordinate(sgrCol) || !isSafeSgrMouseCoordinate(sgrRow)) {
      return ''
    }
    const sgrPress = scope.ESC + '[<0;' + sgrCol + ';' + sgrRow + 'M'
    if (mouseTrackingMode === 'x10') {
      return sgrPress
    }
    return sgrPress + scope.ESC + '[<0;' + sgrCol + ';' + sgrRow + 'm'
  }
  // Why: non-SGR click coordinates use printable ASCII bytes on the mobile
  // bridge; unsafe wide-terminal cells must not turn into corrupted input.
  const col = cell.col + 1 + 32
  const row = cell.row + 1 + 32
  if (col > 126 || row > 126) {
    return ''
  }
  const press =
    scope.ESC + '[M' + String.fromCharCode(32) + String.fromCharCode(col) + String.fromCharCode(row)
  if (mouseTrackingMode === 'x10') {
    return press
  }
  return (
    press +
    scope.ESC +
    '[M' +
    String.fromCharCode(35) +
    String.fromCharCode(col) +
    String.fromCharCode(row)
  )
}

export function isClickMouseTrackingMode(mode: string) {
  return mode !== 'none'
}

export function isWheelMouseTrackingMode(mode: string) {
  return mode !== 'none' && mode !== 'x10'
}

export function shouldRouteScrollToTerminalInput() {
  return isWheelMouseTrackingMode(getMouseTrackingMode()) || isAlternateBufferActive()
}

export function buildMouseWheelScrollInput(lines: number, clientX: number, clientY: number) {
  const count = Math.min(Math.abs(lines), 32)
  if (count === 0) {
    return ''
  }
  const sequence = buildMouseWheelSequence(lines, clientX, clientY)
  if (!sequence) {
    return ''
  }
  return repeatSequence(sequence, count)
}

export function buildTuiScrollInput(lines: number, clientX: number, clientY: number) {
  const count = Math.min(Math.abs(lines), 32)
  if (count === 0) {
    return ''
  }
  const mouseTrackingMode = getMouseTrackingMode()
  let sequence = ''
  if (isWheelMouseTrackingMode(mouseTrackingMode)) {
    sequence = buildMouseWheelSequence(lines, clientX, clientY)
  }
  if (!sequence) {
    sequence = buildArrowScrollSequence(lines)
  }
  return repeatSequence(sequence, count)
}

export function routeScrollLines(lines: number, clientX: number, clientY: number) {
  if (!scope.term || lines === 0) {
    return
  }
  const mouseTrackingMode = getMouseTrackingMode()
  const alternateBufferActive = isAlternateBufferActive()
  if (isWheelMouseTrackingMode(mouseTrackingMode)) {
    // Why: xterm sends wheel events to mouse-aware TUIs before considering
    // scrollback, even if the app stays on the normal buffer.
    const mouseInput = buildMouseWheelScrollInput(lines, clientX, clientY)
    if (mouseInput) {
      notify({ type: 'terminal-input', bytes: mouseInput })
      return
    }
    // Why: default mouse encoding can be unrepresentable in our ASCII-safe
    // RPC path on wide terminals. Send bounded arrows instead of local
    // scrollback/no-op while a mouse-aware app owns scroll gestures.
    const fallbackInput = buildTuiScrollInput(lines, clientX, clientY)
    if (fallbackInput) {
      notify({ type: 'terminal-input', bytes: fallbackInput })
    }
    return
  }
  if (alternateBufferActive) {
    // Why: alternate-screen TUIs own their scroll state and xterm has no
    // scrollback there, so mobile scroll gestures must become terminal input.
    const input = buildTuiScrollInput(lines, clientX, clientY)
    if (input) {
      notify({ type: 'terminal-input', bytes: input })
    }
    return
  }
  scope.term.scrollLines(lines)
}
