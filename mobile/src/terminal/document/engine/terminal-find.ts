import { buildTerminalSearchOptions } from '../../../../../src/shared/terminal/search/terminal-search-options'
import { safeFind } from '../../../../../src/shared/terminal/search/terminal-search-safe-find'
import { notify } from '../host-bridge/host-notify'
import { cancelSelect } from '../selection/selection-mode'
import type { TerminalDocumentScope } from '../document-scope'
import type { TerminalDocumentTerminal } from '../document-terminal-shape'

export type TerminalFindDirection = 'next' | 'previous'

// Same addon and highlight options as desktop terminal search; a missing addon only disables find.
export function attachSearchAddon(
  scope: TerminalDocumentScope,
  term: Pick<TerminalDocumentTerminal, 'loadAddon'>
) {
  // Never leave find pointed at the previous engine's addon, which the surface swap disposes.
  scope.searchAddon = null
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
  // Kept even without an addon so the engine that init builds replays it.
  scope.findQuery = query
  const addon = scope.searchAddon
  if (!addon) {
    return
  }
  if (!query) {
    clearTerminalFind(scope)
    return
  }
  // A search replaces xterm's selection with its match, so a long-press selection must give up its handles first.
  if (scope.selMode === 'select') {
    cancelSelect(scope)
  }
  if (direction === 'next') {
    startFromViewport(scope.term)
  }
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

// With no selection the addon starts at the top of the scrollback; a reader at the bottom expects the match nearest what they see.
function startFromViewport(term: TerminalDocumentTerminal | null) {
  if (!term || term.hasSelection?.() !== false) {
    return
  }
  try {
    term.select(0, term.buffer.active.viewportY, 1)
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
    // When the queued refresh fires it searches an empty term, dropping a long-press selection made since.
    addon._highlightTimeout?.clear()
    // xterm keeps the active match selected after decorations are cleared; a long-press selection made since is the reader's.
    if (scope.selMode !== 'select') {
      addon.findNext('')
    }
  } catch {}
  notify(scope, { type: 'find-results', resultIndex: -1, resultCount: 0 })
}

// A replay builds a new engine; carry an open find onto it so highlights and counts survive reflow.
export function rerunTerminalFind(scope: TerminalDocumentScope) {
  if (scope.findQuery) {
    findInTerminal(scope, scope.findQuery, 'next', true)
  }
}
