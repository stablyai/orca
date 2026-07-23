const INITIAL_PRUNE_RETRY_DELAY_MS = 1_000
const MAX_PRUNE_RETRY_DELAY_MS = 60_000
const MAX_TIMER_DELAY_MS = 2_147_483_647

export class TerminalArchiveExpiryScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private retryDelayMs = INITIAL_PRUNE_RETRY_DELAY_MS

  constructor(
    private readonly now: () => number,
    private readonly prune: () => Promise<void>
  ) {}

  schedule(nextExpiry: number | null): void {
    if (this.disposed) {
      return
    }
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (nextExpiry === null) {
      return
    }
    const delay = Math.max(0, Math.min(nextExpiry - this.now(), MAX_TIMER_DELAY_MS))
    this.scheduleAfter(delay)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private scheduleAfter(delay: number): void {
    if (this.disposed) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.prune().then(
        () => {
          this.retryDelayMs = INITIAL_PRUNE_RETRY_DELAY_MS
        },
        () => {
          if (this.disposed) {
            return
          }
          console.warn('[terminal-archive] Failed to prune expired archives; retrying')
          const retryDelay = this.retryDelayMs
          this.retryDelayMs = Math.min(this.retryDelayMs * 2, MAX_PRUNE_RETRY_DELAY_MS)
          this.scheduleAfter(retryDelay)
        }
      )
    }, delay)
    this.timer.unref?.()
  }
}
