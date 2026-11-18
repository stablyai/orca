// Typed input, even merged while a write is in flight, stays short; pastes arrive in larger or
// escape-framed chunks.
const MAX_SUBMITTED_WRITE_LENGTH = 4_096
const PASTE_FRAME = '\x1b[20'
// oxlint-disable-next-line no-control-regex -- SAFETY: key reports (arrows, kitty) are ESC-led CSI.
const KEY_REPORT = /\x1b\[[0-9;:?]*[A-Za-z~]/g

/** A short write holding a plain Enter submits a line. Pastes and Alt/Shift+Enter (ESC CR) only
 *  edit the draft. */
export function isSubmittedTerminalInput(data: string): boolean {
  if (data.length > MAX_SUBMITTED_WRITE_LENGTH || data.includes(PASTE_FRAME)) {
    return false
  }
  const keys = data.replace(KEY_REPORT, '')
  for (let i = keys.indexOf('\r'); i !== -1; i = keys.indexOf('\r', i + 1)) {
    if (keys[i - 1] !== '\x1b') {
      return true
    }
  }
  return false
}
