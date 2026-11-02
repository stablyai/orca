import type { SetupOutputSession } from './prepared-agent-launch-execution'

/**
 * Puts a line above the cursor's row, so a prompt the shell already drew, and anything typed
 * after it, stay last and keep the cursor. Room is made below first (scrolling at the bottom
 * row), the cursor is saved where its row will land, and the line's rows are inserted above it.
 */
export function lineAboveCursor(text: string, cols: number | undefined): string {
  const rows = Math.max(1, Math.ceil(text.length / Math.max(1, cols ?? text.length)))
  return `${'\n'.repeat(rows)}\x1b7\x1b[${rows}A\r\x1b[${rows}L${text}\x1b8`
}

/** Main's explanation is one bounded line; control bytes could drive the terminal. */
function isOneLine(text: string): boolean {
  return (
    text.length > 0 &&
    text.length <= 512 &&
    ![...text].some((char) => char < ' ' || char === '\u007f')
  )
}

/**
 * Writes main's explanation above the prompt of the exact live Setup, or answers false so main shows its
 * one toast: an alternate screen or a wrapped edit line could not keep what the user typed whole.
 */
export async function writeSetupOutcomeLine(
  liveSetup: () => SetupOutputSession | undefined,
  text: string
): Promise<boolean> {
  const session = liveSetup()
  // The read waits on parsing; the Setup must still be the live one when the line goes in.
  if (!session || !isOneLine(text) || !(await session.takesLineAboveCursor()) || !liveSetup()) {
    return false
  }
  session.startupIngress.accept(lineAboveCursor(`[orca] ${text}`, session.cols))
  return true
}
