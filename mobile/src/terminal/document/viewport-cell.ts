import { getCellHeight, getCellWidth, getTotalScale } from './cell-metrics'
import type { TerminalDocumentScope } from './document-scope'

// Subtract the host origin before grid mapping; embedded terminals sit below headers while native windows start at zero.
export function viewportPoint(scope: TerminalDocumentScope, clientX: number, clientY: number) {
  const frame = scope.viewportRect()
  return { x: clientX - frame.left, y: clientY - frame.top }
}

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
  const point = viewportPoint(scope, clientX, clientY)
  const sx = (point.x - scope.panX) / total
  const sy = (point.y - scope.panY) / total
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
