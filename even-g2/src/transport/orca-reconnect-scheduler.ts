// Escalating reconnect backoff (spec S6): each consecutive failed attempt waits longer, capped at
// the last entry, and only resets on an explicit reset() (a successful re-authentication).
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000]

export class ReconnectScheduler {
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  get attemptCount(): number {
    return this.attempt
  }

  schedule(callback: () => void): void {
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)]!
    this.attempt += 1
    this.timer = setTimeout(() => {
      this.timer = null
      callback()
    }, delay)
  }

  reset(): void {
    this.attempt = 0
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
