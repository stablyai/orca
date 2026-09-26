import { getLineText } from './cell-geometry'
import type { TerminalDocumentScope, TerminalDocumentSelection } from './document-scope'
import { notify } from './host-notify'
import { repositionOverlay, stopEdgeScroll } from './selection-overlay'

/** What counts as one word for select-all and for word seeding. */
const WORD_RE = /[\p{L}\p{N}_./:@~+=?&#%-]/u

/** The ordered ends of the selection, whichever way the user dragged it. */
export type TerminalSelectionRange = {
  start: TerminalDocumentSelection['anchor']
  end: TerminalDocumentSelection['anchor']
}

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

export function isStartFirst(
  a: TerminalDocumentSelection['anchor'],
  b: TerminalDocumentSelection['anchor']
) {
  if (a.row !== b.row) {
    return a.row < b.row
  }
  return a.col <= b.col
}

export function selRange(scope: TerminalDocumentScope): TerminalSelectionRange | null {
  if (!scope.sel) {
    return null
  }
  if (isStartFirst(scope.sel.anchor, scope.sel.focus)) {
    return { start: scope.sel.anchor, end: scope.sel.focus }
  }
  return { start: scope.sel.focus, end: scope.sel.anchor }
}

export function applyXtermSelection(scope: TerminalDocumentScope) {
  if (!scope.term || !scope.sel) {
    return
  }
  const r = selRange(scope)
  if (!r) {
    return
  }
  // Why: term.select(col, row, length) takes a buffer-absolute row,
  // not a viewport-relative one. Subtracting viewportY here drifts the
  // selection by the scrollback height — handles render where the user
  // pressed (their math is independent), but xterm highlights an
  // off-screen scrollback region and copies the wrong text.
  let length: number
  if (r.start.row === r.end.row) {
    length = Math.max(1, r.end.col - r.start.col + 1)
  } else {
    const first = scope.term.cols - r.start.col
    const middle = Math.max(0, r.end.row - r.start.row - 1) * scope.term.cols
    const last = r.end.col + 1
    length = first + middle + last
  }
  try {
    scope.term.select(r.start.col, r.start.row, length)
  } catch {}
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
