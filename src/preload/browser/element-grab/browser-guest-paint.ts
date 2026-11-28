/**
 * How long a clean teardown or a capture's prepare step waits for two frames. A loaded machine can
 * render at a few frames a second right after a page load (measured ~5 fps on CI), so 500 ms
 * refused a clean that was only slow. Both callers run inside a 2 s execution budget.
 */
export const GUEST_PAINT_WAIT_MS = 1_200

/** Hidden guests can miss paint; retire their queued frame on either outcome. */
export function waitForGuestPaint(): Promise<boolean> {
  return new Promise((resolve) => {
    let frame = 0
    let done = false
    const finish = (painted: boolean): void => {
      if (done) {
        return
      }
      done = true
      clearTimeout(timer)
      cancelAnimationFrame(frame)
      resolve(painted)
    }
    const timer = setTimeout(() => finish(false), GUEST_PAINT_WAIT_MS)
    try {
      frame = requestAnimationFrame(() => {
        if (!done) {
          frame = requestAnimationFrame(() => finish(true))
        }
      })
    } catch {
      finish(false)
    }
  })
}
