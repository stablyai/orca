// Only an outstanding reply (state or an event-driven probe) arms a deadline: no idle timer in either process.
export const REPLY_TIMEOUT = 15_000

/** One pending-reply deadline; paused across system sleep so a sleeping helper isn't killed. */
export class MenuBarReplyDeadline {
  private timer: ReturnType<typeof setTimeout> | null = null
  private suspended = false
  private onExpire: (() => void) | null = null
  private timeoutMs = REPLY_TIMEOUT

  get armed(): boolean {
    return this.onExpire !== null
  }

  get paused(): boolean {
    return this.suspended
  }

  arm(onExpire: () => void, timeoutMs = REPLY_TIMEOUT): void {
    this.onExpire = onExpire
    this.timeoutMs = timeoutMs
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
      // After a long main-thread stall timers run before I/O; a fresh timer runs only after the next
      // I/O poll, so a reply already in the pipe lands first.
      this.timer = setTimeout(() => {
        this.timer = null
        const expire = this.onExpire
        if (expire && !this.suspended) {
          this.onExpire = null
          expire()
        }
      }, 0)
      this.timer.unref()
    }, this.timeoutMs)
    this.timer.unref()
  }
}
