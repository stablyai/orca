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
  scope.scrollbackRows = scrollbackRows
  for (const term of [scope.term, scope.committedTerm, scope.provisionalTerm]) {
    if (term) {
      term.options.scrollback = scrollbackRows
    }
  }
}
