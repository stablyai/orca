import type { TerminalDocumentScope, TerminalDocumentSelection } from './document-scope'

/** The ordered ends of the selection, whichever way the user dragged it. */
export type TerminalSelectionRange = {
  start: TerminalDocumentSelection['anchor']
  end: TerminalDocumentSelection['anchor']
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
