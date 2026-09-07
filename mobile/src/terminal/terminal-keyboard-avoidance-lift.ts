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
  if (metrics.altScreen) {
    return keyboardLift
  }
  const rowHeight = terminalFrameHeight / metrics.rows
  // Main-buffer TUI footer rows can sit below the caret.
  const anchorRow = Math.max(metrics.cursorY, metrics.contentBottomRow)
  const anchorBottom = (anchorRow + 1) * rowHeight
  const dockTop = terminalFrameHeight - keyboardLift
  const margin = rowHeight
  return Math.min(keyboardLift, Math.max(0, anchorBottom + margin - dockTop))
}
