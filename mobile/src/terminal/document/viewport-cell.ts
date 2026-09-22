import type { TerminalDocumentScope } from './document-scope'
import { getCellHeight } from './fit-scale'
import { getCellWidth, getTotalScale } from './viewport-transform'

export function viewportToCell(scope: TerminalDocumentScope, clientX: number, clientY: number) {
  if (!scope.term) {
    return null
  }
  const cellW = getCellWidth(scope)
  const cellH = getCellHeight(scope)
  if (cellW <= 0 || cellH <= 0) {
    return null
  }
  let total = getTotalScale(scope)
  if (total <= 0) {
    total = 1
  }
  const sx = (clientX - scope.panX) / total
  const sy = (clientY - scope.panY) / total
  let col = Math.floor(sx / cellW)
  let viewportRow = Math.floor(sy / cellH)
  if (col < 0) {
    col = 0
  }
  if (col > scope.term.cols - 1) {
    col = scope.term.cols - 1
  }
  if (viewportRow < 0) {
    viewportRow = 0
  }
  if (viewportRow > scope.term.rows - 1) {
    viewportRow = scope.term.rows - 1
  }
  const viewportY = scope.term.buffer.active.viewportY
  return { col: col, row: viewportRow + viewportY }
}
