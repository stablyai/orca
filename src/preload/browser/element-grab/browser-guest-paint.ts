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
    const timer = setTimeout(() => finish(false), 500)
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
