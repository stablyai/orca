export const DEFAULT_AUTHORITY_REPLACEMENT_GRACE_MS = 45_000

/**
 * Holds a composition open while a replaced runtime's successor comes back to reclaim its guests.
 *
 * The bound is the point: a runtime that never returns would otherwise leave live webviews attached
 * to an authority that will never speak again, which is worse than retiring the environment. Arming
 * is idempotent, so a burst of mismatch errors still yields one deadline.
 */
export class BrowserClientHostAuthorityReplacementWait {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly graceMs: number = DEFAULT_AUTHORITY_REPLACEMENT_GRACE_MS) {}

  arm(expire: () => void): void {
    if (this.timer) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      expire()
    }, this.graceMs)
    this.timer.unref?.()
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  get armed(): boolean {
    return this.timer !== null
  }
}
