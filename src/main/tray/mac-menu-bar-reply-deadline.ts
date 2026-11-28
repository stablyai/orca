// Only an outstanding reply (state or an event-driven probe) arms a deadline: no idle timer in either process.
const REPLY_TIMEOUT = 15_000

/** One pending-reply deadline; paused across system sleep so a sleeping helper isn't killed. */
export class MenuBarReplyDeadline {
  private timer: ReturnType<typeof setTimeout> | null = null
  private suspended = false
  private onExpire: (() => void) | null = null

  get armed(): boolean {
    return this.onExpire !== null
  }

  get paused(): boolean {
    return this.suspended
  }

  arm(onExpire: () => void): void {
    this.onExpire = onExpire
    this.restart()
  }

  disarm(): void {
    this.onExpire = null
    clearTimeout(this.timer ?? undefined)
    this.timer = null
  }

  suspend(): void {
    this.suspended = true
  }

  resume(): void {
    this.suspended = false
    if (this.onExpire) {
      this.restart()
    }
  }

  private restart(): void {
    clearTimeout(this.timer ?? undefined)
    this.timer = setTimeout(() => {
      this.timer = null
      const expire = this.onExpire
      if (expire && !this.suspended) {
        this.onExpire = null
        expire()
      }
    }, REPLY_TIMEOUT)
    this.timer.unref()
  }
}
