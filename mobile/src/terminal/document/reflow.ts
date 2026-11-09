import { applyFitScale } from './fit-scale'
import { isAlternateBufferActive } from './mouse-input-encoding'
import { updateScrollIndicator } from './viewport-transform'
import { emitKeyboardAvoidanceMetrics } from './keyboard-avoidance-metrics'
import type { TerminalDocumentScope } from './document-scope'

// Rewrap scrollback after PTY width changes; skip alternate screens, whose full repaints can lose SGR under local resize.
export function reflow(scope: TerminalDocumentScope, cols: number, rows: number) {
  if (!scope.term || isAlternateBufferActive(scope)) {
    return
  }
  const nextCols = cols || scope.term.cols
  const nextRows = rows || scope.term.rows
  if (nextCols === scope.term.cols && nextRows === scope.term.rows) {
    return
  }
  const buffer = scope.term.buffer.active
  // Preserve distance from bottom across rewrap, including bottom-pinned readers.
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
  applyFitScale(scope, 'reflow-msg')
  updateScrollIndicator(scope, false)
  emitKeyboardAvoidanceMetrics(scope)
}
