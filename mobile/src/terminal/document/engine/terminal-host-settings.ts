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
  // A buffer that may already have dropped rows keeps its size until the next init: resizing it would
  // move rows under the selection and OSC-link bookkeeping, which count only line feeds.
  const rows = scope.term?.rows || 0
  if (scope.term && scope.linesEverWritten >= Math.min(previous, scrollbackRows) + rows) {
    return
  }
  for (const term of [scope.term, scope.committedTerm, scope.provisionalTerm]) {
    if (term) {
      term.options.scrollback = scrollbackRows
    }
  }
}
