// Consecutive helpers that never showed the icon before main falls back to the in-process tray.
const MAX_FAILED_STARTS = 3
const MAX_RETRY_DELAY = 60_000

/** Back-off for replacing a helper, and when to stop trying. */
export class MenuBarRestartPolicy {
  private failedStarts = 0
  private delay = 1_000

  /** Delay before the next helper, or null to give up on the helper for this launch. */
  next(showedIcon: boolean, livedMs: number): number | null {
    this.failedStarts = showedIcon ? 0 : this.failedStarts + 1
    if (this.failedStarts >= MAX_FAILED_STARTS) {
      return null
    }
    // A helper that dies soon after showing the icon keeps backing off.
    if (livedMs > MAX_RETRY_DELAY) {
      this.delay = 1_000
    }
    const delay = this.delay
    this.delay = Math.min(this.delay * 2, MAX_RETRY_DELAY)
    return delay
  }
}
