import { applyXtermSelection } from './selection-span'
export { applyXtermSelection, isStartFirst, selRange } from './selection-span'
export type { TerminalSelectionRange } from './selection-span'
import { getLineText } from './cell-geometry'
import type { TerminalDocumentScope } from './document-scope'
import { notify } from './host-notify'
import { repositionOverlay, stopEdgeScroll } from './selection-overlay'

/** What counts as one word for select-all and for word seeding. */
const WORD_RE = /[\p{L}\p{N}_./:@~+=?&#%-]/u

export function seedWordSelection(scope: TerminalDocumentScope, col: number, absRow: number) {
  const line = getLineText(scope, absRow)
  if (!line) {
    scope.sel = {
      anchor: { col: col, row: absRow },
      focus: { col: col, row: absRow },
      activeHandle: null
    }
    applyXtermSelection(scope)
    return
  }
  let s = col
  let e = col
  if (col >= 0 && col < line.length && WORD_RE.test(line[col])) {
    while (s > 0 && WORD_RE.test(line[s - 1])) {
      s--
    }
    while (e < line.length - 1 && WORD_RE.test(line[e + 1])) {
      e++
    }
  }
  scope.sel = {
    anchor: { col: s, row: absRow },
    focus: { col: e, row: absRow },
    activeHandle: null
  }
  applyXtermSelection(scope)
}

export function cancelSelect(scope: TerminalDocumentScope) {
  scope.selMode = 'navigate'
  scope.sel = null
  stopEdgeScroll(scope)
  if (scope.term) {
    try {
      scope.term.clearSelection()
    } catch {}
    // Why: some xterm renderers cache cells and skip repaint on
    // clearSelection alone, leaving the previously-highlighted cells
    // visually selected. Force a full refresh so the selection layer
    // actually clears on screen.
    try {
      scope.term.refresh(0, scope.term.rows - 1)
    } catch {}
  }
  scope.selectionOverlay!.classList.remove('active')
  notify(scope, { type: 'set-select-mode', enabled: false })
}

export function enterSelect(scope: TerminalDocumentScope, col: number, absRow: number) {
  scope.selMode = 'select'
  seedWordSelection(scope, col, absRow)
  scope.selectionOverlay!.classList.add('active')
  notify(scope, { type: 'set-select-mode', enabled: true })
  notify(scope, { type: 'haptic', kind: 'selection' })
  repositionOverlay(scope)
}
