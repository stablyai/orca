import type { TerminalDocumentScope } from './document-scope'

export function resizeTerminalBuffer(scope: TerminalDocumentScope, cols: number, rows: number) {
  const terminal = scope.term
  if (!terminal) {
    return
  }
  const invalidatePendingAnchor =
    terminal === scope.pendingTerm &&
    scope.pendingReplayScrollAnchorRows !== null &&
    (cols !== terminal.cols || rows !== terminal.rows)
  terminal.resize(cols, rows)
  if (invalidatePendingAnchor) {
    scope.pendingReplayScrollAnchorRows = 0
  }
}
