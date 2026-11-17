import { TERMINAL_VIEWPORT_MIN_ROWS } from '../../../shared/terminal/viewport/terminal-viewport'

// Why: long enough for the program to read the shorter size before the grid comes back.
const REPAINT_RESTORE_MS = 250

type PtySize = { cols: number; rows: number }

/** Asks the PTY's program to redraw by resizing it one row smaller and back: a same-size resize
 *  sends no SIGWINCH. It lives beside the PTY so the way back survives a lost client, and only the
 *  PTY moves, so the grid attaches read stays real. A real resize meanwhile owns the grid. */
export class SessionRepaintNudge {
  /** The grid the nudge in flight restores; a request on another grid starts its own. */
  private inFlight: PtySize | null = null

  request(
    readGrid: () => PtySize | null,
    resizePty: (cols: number, rows: number) => void,
    isLive: () => boolean
  ): void {
    const grid = readGrid()
    // Why not Windows: ConPTY answers a resize by replaying its own viewport, not the program's paint.
    if (process.platform === 'win32' || !grid || grid.cols < 1 || grid.rows < 1) {
      return
    }
    const { cols, rows } = grid
    if (this.inFlight?.cols === cols && this.inFlight.rows === rows) {
      return
    }
    const nudge = { cols, rows }
    this.inFlight = nudge
    resizePty(cols, rows > TERMINAL_VIEWPORT_MIN_ROWS ? rows - 1 : rows + 1)
    setTimeout(() => {
      if (this.inFlight !== nudge) {
        return
      }
      this.inFlight = null
      const current = readGrid()
      if (isLive() && current?.cols === cols && current.rows === rows) {
        resizePty(cols, rows)
      }
    }, REPAINT_RESTORE_MS).unref?.()
  }
}
