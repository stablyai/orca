import { sameCellBox, type TerminalLaidOutCellBox } from '../terminal-cell-box'
import type { TerminalDocumentScope } from './document-scope'
import { notify } from './host-notify'

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

// Report changed measured boxes; refit only when the grid is unchanged or grid-driven refits would loop.
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
