const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

export function isValidPtySize(cols: number, rows: number): boolean {
  return Number.isFinite(cols) && Number.isFinite(rows) && cols >= 1 && rows >= 1
}

export function normalizePtySize(cols: number, rows: number): { cols: number; rows: number } {
  if (isValidPtySize(cols, rows)) {
    return { cols, rows }
  }
  return { cols: DEFAULT_COLS, rows: DEFAULT_ROWS }
}
