export const DEFAULT_AUTHORITY_REPLACEMENT_GRACE_MS = 45_000

/** Allow restart to reclaim live guests, but expire the hold if no successor arrives. */
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
