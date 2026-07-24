import { isValidTerminalSize, normalizeTerminalSize } from '../../shared/terminal-size-limits'

export function isValidPtySize(cols: number, rows: number): boolean {
  return isValidTerminalSize(cols, rows)
}

export function normalizePtySize(cols: number, rows: number): { cols: number; rows: number } {
  return normalizeTerminalSize(cols, rows)
}
