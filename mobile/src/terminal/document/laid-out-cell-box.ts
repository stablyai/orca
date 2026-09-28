import type { TerminalCellBox } from '../terminal-cell-box'
import type { TerminalDocumentScope } from './document-scope'
import { notify } from './host-notify'

/** The box xterm actually laid out, for the scale it was opened at; null before one. */
export function laidOutCellBox(scope: TerminalDocumentScope): TerminalCellBox | null {
  const core = scope.term && scope.term._core
  const dimensions = core && core._renderService && core._renderService.dimensions
  if (!dimensions || !scope.term) {
    return null
  }
  const { width, height } = dimensions.css.cell
  if (!(width > 0 && height > 0)) {
    return null
  }
  return { fontScale: scope.currentTextScale, cellWidth: width, cellHeight: height }
}

/**
 * Tells the host the box xterm laid out whenever it or the grid changes: after init, a renderer
 * swap on context loss, a text-size or DPR change, or a resize (the DOM renderer's width depends on
 * cols). A new grid is reported with an unchanged box too, so the host holds the grid in place
 * when a later renderer swap arrives at it.
 */
export function reportLaidOutCellBox(scope: TerminalDocumentScope) {
  const laidOut = laidOutCellBox(scope)
  if (!laidOut || !scope.term) {
    return
  }
  const { cols, rows } = scope.term
  const last = scope.reportedCellBox
  if (
    last &&
    last.cols === cols &&
    last.rows === rows &&
    last.cellBox.fontScale === laidOut.fontScale &&
    last.cellBox.cellWidth === laidOut.cellWidth &&
    last.cellBox.cellHeight === laidOut.cellHeight
  ) {
    return
  }
  scope.reportedCellBox = { cellBox: laidOut, cols, rows }
  notify(scope, { type: 'cell-metrics', ...scope.reportedCellBox })
}
