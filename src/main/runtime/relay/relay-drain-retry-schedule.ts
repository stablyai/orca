import { relayRetryDelayMs } from './relay-retry-delay'

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
    const jitterMs = relayRetryDelayMs(this.attempt, this.random)
    this.attempt++
    this.timer = setTimeout(
      () => {
        this.timer = null
        retry()
      },
      Math.max(jitterMs, retryAfterMs)
    )
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
