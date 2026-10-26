// Share frame/cell fitting between app and document so initial subscribe and later refits choose the same grid.

export type TerminalFitDimensions = { cols: number; rows: number }

export const MIN_FIT_COLS = 20
export const MIN_FIT_ROWS = 8

// Pixel-ratio division can round exact fits below an integer; a genuine one-device-pixel shortfall is much larger.
const EXACT_FIT_TOLERANCE = 1e-6

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
