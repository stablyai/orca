/**
 * The one fit of a cell box to the terminal frame, shared by the app and the document so a first
 * subscribe and every later refit reach the same grid from the same frame width.
 */

export type TerminalFitDimensions = { cols: number; rows: number }

/** Below these the fit is not a terminal anyone can read, and the caller disables fit-to-phone. */
export const MIN_FIT_COLS = 20
export const MIN_FIT_ROWS = 8

// Why: frame and cell are each device pixels over the pixel ratio, so an exact fit can divide to
// 49.999…; a real shortfall is at least 1/cell-device-px (> 0.02) below the next integer.
const EXACT_FIT_TOLERANCE = 1e-6

/** The grid the frame (as React Native laid it out) holds at this cell box; null when too narrow. */
export function fitDimensionsFromCell(
  cell: { cellWidth: number; cellHeight: number },
  width: number,
  height: number
): TerminalFitDimensions | null {
  const cols = Math.floor(width / cell.cellWidth + EXACT_FIT_TOLERANCE)
  if (!(cols >= MIN_FIT_COLS)) {
    return null
  }
  const rows = Math.floor(height / cell.cellHeight + EXACT_FIT_TOLERANCE)
  return { cols, rows: Math.max(MIN_FIT_ROWS, rows) }
}
