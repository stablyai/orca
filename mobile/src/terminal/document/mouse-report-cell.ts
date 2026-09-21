import { getCellHeight } from './fit-scale'
import { getCellWidth, getTotalScale } from './viewport-transform'
import { scope } from './document-scope'

/** Where a viewport point lands in the terminal's cell grid, for an xterm mouse report. */
export type MouseReportCell = { col: number; row: number; x: number; y: number }

/**
 * Maps a viewport point to a mouse-report cell, or null when there is no grid to map onto.
 *
 * Reads through the pan offset and the total scale rather than the element's box: the surface is a
 * transformed layer, so its on-screen geometry is not the geometry xterm reports in.
 */
export function viewportToMouseReportCell(
  clientX: number,
  clientY: number
): MouseReportCell | null {
  if (!scope.term) {
    return null
  }
  const cellW = getCellWidth()
  const cellH = getCellHeight()
  if (cellW <= 0 || cellH <= 0) {
    return null
  }
  if (typeof clientX !== 'number') {
    clientX = window.innerWidth / 2
  }
  if (typeof clientY !== 'number') {
    clientY = window.innerHeight / 2
  }
  let total = getTotalScale()
  if (total <= 0) {
    total = 1
  }
  let sx = (clientX - scope.panX) / total
  let sy = (clientY - scope.panY) / total
  const maxX = Math.max(0, scope.term.cols * cellW - 1)
  const maxY = Math.max(0, scope.term.rows * cellH - 1)
  if (sx < 0) {
    sx = 0
  }
  if (sx > maxX) {
    sx = maxX
  }
  if (sy < 0) {
    sy = 0
  }
  if (sy > maxY) {
    sy = maxY
  }
  let col = Math.floor(sx / cellW)
  let row = Math.floor(sy / cellH)
  if (col < 0) {
    col = 0
  }
  if (col > scope.term.cols - 1) {
    col = scope.term.cols - 1
  }
  if (row < 0) {
    row = 0
  }
  if (row > scope.term.rows - 1) {
    row = scope.term.rows - 1
  }
  return { col: col, row: row, x: Math.floor(sx), y: Math.floor(sy) }
}
