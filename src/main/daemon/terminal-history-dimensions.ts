// Why separate from live admission: existing recovery was written through a 1,000-column viewport contract.
const MAX_TERMINAL_HISTORY_COLS = 1_000
const MAX_TERMINAL_HISTORY_ROWS = 500

export function isValidTerminalHistorySize(cols: unknown, rows: unknown): boolean {
  return (
    Number.isSafeInteger(cols) &&
    (cols as number) >= 1 &&
    (cols as number) <= MAX_TERMINAL_HISTORY_COLS &&
    Number.isSafeInteger(rows) &&
    (rows as number) >= 1 &&
    (rows as number) <= MAX_TERMINAL_HISTORY_ROWS
  )
}
