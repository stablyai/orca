import { buildTerminalSearchOptions } from '../../../../../src/shared/terminal/search/terminal-search-options'
import { safeFind } from '../../../../../src/shared/terminal/search/terminal-search-safe-find'
import { notify } from '../host-bridge/host-notify'
import type { TerminalDocumentScope } from '../document-scope'
import type { TerminalDocumentTerminal } from '../document-terminal-shape'

export type TerminalFindDirection = 'next' | 'previous'

// Same addon and highlight options as desktop terminal search; a missing addon only disables find.
export function attachSearchAddon(
  scope: TerminalDocumentScope,
  term: Pick<TerminalDocumentTerminal, 'loadAddon'>
) {
  try {
    const addon = scope.createSearchAddon()
    if (!addon) {
      return
    }
    term.loadAddon(addon)
    addon.onDidChangeResults((results) => {
      if (scope.searchAddon !== addon) {
        return
      }
      notify(scope, {
        type: 'find-results',
        resultIndex: results.resultIndex,
        resultCount: results.resultCount
      })
    })
    scope.searchAddon = addon
  } catch {}
}

export function findInTerminal(
  scope: TerminalDocumentScope,
  query: string,
  direction: TerminalFindDirection,
  incremental: boolean
) {
  const addon = scope.searchAddon
  if (!addon) {
    return
  }
  if (!query) {
    clearTerminalFind(scope)
    return
  }
  scope.findQuery = query
  const options = buildTerminalSearchOptions({ caseSensitive: false, regex: false, incremental })
  try {
    safeFind(
      (term, searchOptions) =>
        direction === 'previous'
          ? addon.findPrevious(term, searchOptions)
          : addon.findNext(term, searchOptions),
      query,
      options
    )
  } catch {}
}

export function clearTerminalFind(scope: TerminalDocumentScope) {
  scope.findQuery = ''
  const addon = scope.searchAddon
  if (!addon) {
    return
  }
  try {
    addon.clearDecorations()
    // xterm keeps the active match selected after decorations are cleared.
    addon.findNext('')
  } catch {}
  notify(scope, { type: 'find-results', resultIndex: -1, resultCount: 0 })
}

// A replay builds a new engine; carry an open find onto it so highlights and counts survive reflow.
export function rerunTerminalFind(scope: TerminalDocumentScope) {
  if (scope.findQuery) {
    findInTerminal(scope, scope.findQuery, 'next', true)
  }
}
