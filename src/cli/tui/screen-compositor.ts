import { CLEAR_TO_EOL, cursorTo, HIDE_CURSOR, RESET } from './ansi-control'

/** Begin/end synchronized output (DECSET 2026). Terminals that support it hold
 *  the display until the end marker, so a multi-row frame paints atomically with
 *  no tearing; terminals that don't simply ignore the private mode. Copied from
 *  herdr's flicker-avoidance approach. */
const SYNC_BEGIN = '\x1b[?2026h'
const SYNC_END = '\x1b[?2026l'

/** A diff-based back-buffer over stdout. Holds the last painted row strings and,
 *  on each frame, rewrites only the rows that changed — wrapped in synchronized
 *  output so the whole frame lands at once. We own the screen directly instead
 *  of going through Ink, which lets the viewport carry verbatim PTY bytes. */
export class ScreenCompositor {
  private readonly write: (chunk: string) => void
  private prev: string[] = []

  constructor(write: (chunk: string) => void = (chunk) => void process.stdout.write(chunk)) {
    this.write = write
  }

  /** Drop the baseline so the next render repaints every row (call on resize,
   *  or after anything else has written to the screen). */
  reset(): void {
    this.prev = []
  }

  /** Paint `rows` (each already a full-width styled string). Only changed rows
   *  are emitted; the cursor stays hidden so it never strobes across the frame. */
  render(rows: readonly string[]): void {
    let out = SYNC_BEGIN + HIDE_CURSOR
    let changed = false
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i] === this.prev[i]) {
        continue
      }
      changed = true
      // Reset before CLEAR_TO_EOL so a prior row's trailing SGR can't tint the
      // cleared remainder of the physical line.
      out += cursorTo(i, 0) + rows[i] + RESET + CLEAR_TO_EOL
    }
    // Clear any rows that existed last frame but not this one (screen shrank).
    for (let i = rows.length; i < this.prev.length; i += 1) {
      changed = true
      out += cursorTo(i, 0) + RESET + CLEAR_TO_EOL
    }
    out += SYNC_END
    if (changed) {
      this.write(out)
    }
    this.prev = rows.slice()
  }
}
