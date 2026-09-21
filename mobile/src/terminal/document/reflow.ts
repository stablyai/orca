import { applyFitScale } from './fit-scale'
import { isAlternateBufferActive } from './mouse-input-encoding'
import { updateScrollIndicator } from './viewport-transform'
import { emitKeyboardAvoidanceMetrics } from './keyboard-avoidance-metrics'
import { scope } from './document-scope'

// Why: rewrap the local xterm buffer (scrollback included) to a new width
// after a server PTY reflow. Skip the alternate screen: those snapshots are
// fully repainted by the PTY and a local resize there can drop SGR attributes
// (see init's alt-screen handling), which shows as white text.
export function reflow(cols: number, rows: number) {
  if (!scope.term || isAlternateBufferActive()) {
    return
  }
  const nextCols = cols || scope.term.cols
  const nextRows = rows || scope.term.rows
  if (nextCols === scope.term.cols && nextRows === scope.term.rows) {
    return
  }
  const buffer = scope.term.buffer.active
  // Why: anchor reflow on whether the user was pinned to the live bottom so
  // their scroll position survives the rewrap — if they were scrolled up,
  // hold the same distance from the bottom; if at the bottom, stay there.
  const wasAtBottom = buffer.viewportY >= buffer.baseY
  const distanceFromBottom = buffer.baseY - buffer.viewportY
  scope.initRows = nextRows
  scope.term.resize(nextCols, nextRows)
  const rewrapped = scope.term.buffer.active
  if (wasAtBottom) {
    scope.term.scrollToBottom()
  } else {
    scope.term.scrollLines(rewrapped.baseY - distanceFromBottom - rewrapped.viewportY)
  }
  applyFitScale('reflow-msg')
  updateScrollIndicator(false)
  emitKeyboardAvoidanceMetrics()
}
