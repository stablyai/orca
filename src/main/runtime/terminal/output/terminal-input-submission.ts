// Typed lines are short; a paste arrives in large or escape-framed chunks.
const MAX_SUBMITTED_LINE_LENGTH = 1_024

/** A short write ending in Enter submits a line. Pastes (escape-framed or chunked large) and
 *  Alt/Shift+Enter (ESC CR) only edit the draft. */
export function isSubmittedTerminalInput(data: string): boolean {
  return data.length <= MAX_SUBMITTED_LINE_LENGTH && data.endsWith('\r') && !data.includes('\x1b')
}
