import type { TerminalKeyboardAvoidanceMetrics } from './terminal-webview-contract'

type ActiveTerminalKeyboardLiftParams = {
  keyboardLift: number
  metrics: TerminalKeyboardAvoidanceMetrics | undefined
  terminalFrameHeight: number
}

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
  // A desktop grid may draw shorter than its frame; cap lift to drawn content, tolerating the fit’s fractional-row gap.
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

function anchorOverflow(
  metrics: TerminalKeyboardAvoidanceMetrics,
  rowHeight: number,
  visibleBottom: number
): number {
  // Main-buffer TUI footers can extend below the caret.
  const anchorRow = Math.max(metrics.cursorY, metrics.contentBottomRow)
  return Math.max(0, (anchorRow + 1) * rowHeight + rowHeight - visibleBottom)
}
