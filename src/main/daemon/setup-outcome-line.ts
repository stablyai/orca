/**
 * Puts a line above the cursor's row, so a prompt the shell already drew, and anything typed
 * after it, stay last and keep the cursor. Room is made below first (scrolling at the bottom
 * row), the cursor is saved where its row will land, and the line's rows are inserted above it.
 */
export function lineAboveCursor(text: string, cols: number | undefined): string {
  const rows = Math.max(1, Math.ceil(text.length / Math.max(1, cols ?? text.length)))
  return `${'\n'.repeat(rows)}\x1b7\x1b[${rows}A\r\x1b[${rows}L${text}\x1b8`
}
