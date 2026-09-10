import { computeRetryDelayMs } from './relay-retry-backoff'

export class RelayDrainRetrySchedule {
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

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.reset()
  }
}
