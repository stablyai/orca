import type { TerminalKeyboardAvoidanceMetrics } from './terminal-webview-contract'

type ActiveTerminalKeyboardLiftParams = {
  // What the keyboard covers of the frame.
  keyboardLift: number
  metrics: TerminalKeyboardAvoidanceMetrics | undefined
  terminalFrameHeight: number
}

/**
 * How far to lift the active pane so its anchor row clears the keyboard. Never more than the strip
 * the keyboard covers, nor more than it hides of the grid as drawn.
 */
export function computeActiveTerminalKeyboardLift(
  params: ActiveTerminalKeyboardLiftParams
): number {
  const { keyboardLift, metrics, terminalFrameHeight } = params
  if (keyboardLift <= 0) {
    return 0
  }
  if (!metrics || metrics.rows <= 0 || terminalFrameHeight <= 0) {
    return keyboardLift
  }
  const dockTop = terminalFrameHeight - keyboardLift
  const pitch = metrics.rowPitch
  // Desktop display mode draws the desktop's rows scaled down, well short of the frame; lifting
  // by the strip there moved the whole grid under the header. The fit floors rows, so a gap under
  // one row is a grid that fills the frame, and keeps the arithmetic below.
  if (pitch && metrics.rows * pitch < terminalFrameHeight - pitch) {
    const drawnHidden = metrics.rows * pitch - dockTop
    if (drawnHidden <= 0) {
      return 0
    }
    const hidden = Math.min(keyboardLift, drawnHidden)
    return metrics.altScreen ? hidden : Math.min(hidden, anchorOverflow(metrics, pitch, dockTop))
  }
  if (metrics.altScreen) {
    return keyboardLift
  }
  const rowHeight = terminalFrameHeight / metrics.rows
  return Math.min(keyboardLift, anchorOverflow(metrics, rowHeight, dockTop))
}

/** How far the anchor row, plus one row of margin, reaches below `visibleBottom`. */
function anchorOverflow(
  metrics: TerminalKeyboardAvoidanceMetrics,
  rowHeight: number,
  visibleBottom: number
): number {
  // Main-buffer TUI footer rows can sit below the caret.
  const anchorRow = Math.max(metrics.cursorY, metrics.contentBottomRow)
  return Math.max(0, (anchorRow + 1) * rowHeight + rowHeight - visibleBottom)
}
