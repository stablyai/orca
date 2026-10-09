// Why: recover brief failures quickly without turning a sustained outage into auth/director load.
const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 5 * 60_000

// Full-jitter exponential backoff, floored at the server's Retry-After.
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
    const exponent = Math.min(this.attempt, Math.ceil(Math.log2(RETRY_MAX_MS / RETRY_BASE_MS)))
    const capMs = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exponent)
    this.attempt++
    const jitterMs = Math.floor(this.random() * (capMs + 1))
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
