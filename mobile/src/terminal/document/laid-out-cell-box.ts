import { sameCellBox, type TerminalLaidOutCellBox } from '../terminal-cell-box'
import type { TerminalDocumentScope } from './document-scope'
import { notify } from './host-notify'

/** The box xterm laid out at the current text scale, with its grid; null before one. */
export function laidOutCellBox(scope: TerminalDocumentScope): TerminalLaidOutCellBox | null {
  const term = scope.term
  const dimensions = term && term._core && term._core._renderService?.dimensions
  if (!term || !dimensions) {
    return null
  }
  const { width, height } = dimensions.css.cell
  if (!(width > 0 && height > 0)) {
    return null
  }
  const cellBox = { fontScale: scope.currentTextScale, cellWidth: width, cellHeight: height }
  return { cellBox, cols: term.cols, rows: term.rows }
}

/**
 * Tells the host each box xterm lays out that differs from the last: after init, a renderer swap
 * on context loss, a text-size or DPR change, or a resize (the DOM renderer's width follows cols).
 * `refit` is a box that changed while the grid did not, which only a renderer or pixel-ratio
 * change does; one that arrives with a new grid is that grid's own, so refitting it would loop.
 */
export function reportLaidOutCellBox(scope: TerminalDocumentScope) {
  const laidOut = laidOutCellBox(scope)
  if (!laidOut) {
    return
  }
  const last = scope.reportedCellBox
  scope.reportedCellBox = laidOut
  if (last && sameCellBox(last.cellBox, laidOut.cellBox)) {
    return
  }
  const refit = last !== null && last.cols === laidOut.cols && last.rows === laidOut.rows
  notify(scope, { type: 'cell-box', cellBox: laidOut.cellBox, refit })
}
