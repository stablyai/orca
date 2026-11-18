const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/** Enter submits a line; pasted text (its framing can span writes) and Alt/Shift+Enter (ESC CR)
 *  only edit the draft. */
export function scanTerminalInputSubmission(
  data: string,
  pasteOpen: boolean
): { submitted: boolean; pasteOpen: boolean } {
  let open = pasteOpen
  let submitted = false
  for (let i = 0; i < data.length; i++) {
    if (data.startsWith(PASTE_START, i)) {
      open = true
      i += PASTE_START.length - 1
    } else if (data.startsWith(PASTE_END, i)) {
      open = false
      i += PASTE_END.length - 1
    } else if (!open && data[i] === '\r' && data[i - 1] !== '\x1b') {
      submitted = true
    }
  }
  return { submitted, pasteOpen: open }
}

/** Bracketed-paste framing per live PTY record; it can span accepted writes. */
export class TerminalInputSubmissions {
  private readonly pasteOpenByPty = new WeakMap<object, boolean>()

  submitted(pty: object, data: string): boolean {
    const scan = scanTerminalInputSubmission(data, this.pasteOpenByPty.get(pty) === true)
    this.pasteOpenByPty.set(pty, scan.pasteOpen)
    return scan.submitted
  }
}
