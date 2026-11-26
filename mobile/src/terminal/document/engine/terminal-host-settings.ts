import type { TerminalDocumentScope } from '../document-scope'

// The page sends the host's Scrollback Rows (already capped for phone memory) and Word Separator.
export function applyTerminalHostSettings(
  scope: TerminalDocumentScope,
  scrollbackRows: unknown,
  wordSeparator: unknown
) {
  if (typeof wordSeparator === 'string') {
    scope.wordSeparator = wordSeparator
  }
  if (
    typeof scrollbackRows !== 'number' ||
    !Number.isFinite(scrollbackRows) ||
    scrollbackRows <= 0 ||
    scrollbackRows === scope.scrollbackRows
  ) {
    return
  }
  const previous = scope.scrollbackRows
  scope.scrollbackRows = scrollbackRows
  // A buffer that may already have dropped rows (by line feeds or a narrowing reflow) keeps its size
  // until the next init: resizing it would move rows under the selection and OSC-link bookkeeping.
  const term = scope.term
  if (term) {
    const limit = Math.min(previous, scrollbackRows) + (term.rows || 0)
    const heldRows = term.buffer.normal?.length ?? term.buffer.active.length
    if (scope.linesEverWritten >= limit || heldRows >= limit) {
      return
    }
  }
  // The guarded live terminal and an empty pre-ready one; an outgoing terminal mid-swap keeps its rows.
  for (const term of [scope.term, scope.provisionalTerm]) {
    if (term) {
      term.options.scrollback = scrollbackRows
    }
  }
}
