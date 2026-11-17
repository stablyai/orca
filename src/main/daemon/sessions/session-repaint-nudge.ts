import { TERMINAL_VIEWPORT_MIN_ROWS } from '../../../shared/terminal/viewport/terminal-viewport'

// Why: long enough for the program to read the shorter size before the grid comes back.
const REPAINT_RESTORE_MS = 250

type PtySize = { cols: number; rows: number }

/** Asks the PTY's program to redraw by resizing it one row smaller and back: a same-size resize
 *  sends no SIGWINCH. It lives beside the PTY so the way back survives a lost client, and only the
 *  PTY moves, so the grid attaches read stays real. A real resize meanwhile owns the grid. */
export class SessionRepaintNudge {
  private pending = false

  request(
    readGrid: () => PtySize | null,
    resizePty: (cols: number, rows: number) => void,
    isLive: () => boolean
  ): void {
    const size = readGrid()
    // Why not Windows: ConPTY answers a resize by replaying its own viewport, not the program's paint.
    if (process.platform === 'win32' || this.pending || !size || size.cols < 1 || size.rows < 1) {
      return
    }
    const { cols, rows } = size
    resizePty(cols, rows > TERMINAL_VIEWPORT_MIN_ROWS ? rows - 1 : rows + 1)
    this.pending = true
    setTimeout(() => {
      this.pending = false
      const grid = readGrid()
      if (isLive() && grid?.cols === cols && grid.rows === rows) {
        resizePty(cols, rows)
      }
    }, REPAINT_RESTORE_MS).unref?.()
  }
}
