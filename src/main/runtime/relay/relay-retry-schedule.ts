import { computeRetryDelayMs } from './relay-retry-backoff'

// One armed retry at a time with jittered exponential backoff. A waiter sits through an armed
// retry by parking on the coordinator's authority, which the retry ends when it fires.
export class RelayRetrySchedule {
  private timer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0

  constructor(private readonly random: () => number = Math.random) {}

  get pending(): boolean {
    return this.timer !== null
  }

  schedule(retryAfterMs: number, retry: () => void): void {
    if (this.timer) {
      return
    }
    const delayMs = computeRetryDelayMs(this.attempt++, retryAfterMs, this.random)
    this.timer = setTimeout(() => {
      this.timer = null
      retry()
    }, delayMs)
  }

  reset(): void {
    this.attempt = 0
  }

  // Why no reset(): the coordinator gates that on resetRetry, so a superseded retry keeps its
  // place on the backoff ladder rather than restarting it on every reconcile.
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
