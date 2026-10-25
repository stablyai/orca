const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 5 * 60_000

// Jittered exponential backoff that recovers brief failures quickly without
// turning a sustained outage into auth/director load. One pending retry at a time.
export class RelayRetrySchedule {
  private timer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private dueAt: number | null = null
  private readonly settledWaiters = new Set<() => void>()

  constructor(private readonly random: () => number = Math.random) {}

  get pending(): boolean {
    return this.timer !== null
  }

  // Consecutive scheduled retries since the last reset (a success or a fresh demand).
  get attempts(): number {
    return this.attempt
  }

  get retryAt(): number | null {
    return this.dueAt
  }

  // Resolves once the pending retry has run or was cancelled.
  settled(): Promise<void> {
    return this.timer
      ? new Promise((resolve) => this.settledWaiters.add(resolve))
      : Promise.resolve()
  }

  schedule(retryAfterMs: number, retry: () => void): void {
    if (this.timer) {
      return
    }
    const exponent = Math.min(this.attempt, Math.ceil(Math.log2(RETRY_MAX_MS / RETRY_BASE_MS)))
    const capMs = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exponent)
    this.attempt++
    const delayMs = Math.max(Math.floor(this.random() * (capMs + 1)), retryAfterMs)
    this.dueAt = Date.now() + delayMs
    this.timer = setTimeout(() => {
      this.clearTimer()
      retry()
      this.settle()
    }, delayMs)
  }

  reset(): void {
    this.attempt = 0
  }

  // Keeps the attempt count: a superseding reconcile still backs off from it.
  cancel(): void {
    if (this.timer) {
      this.clearTimer()
      this.settle()
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = null
    this.dueAt = null
  }

  private settle(): void {
    const waiters = [...this.settledWaiters]
    this.settledWaiters.clear()
    for (const resolve of waiters) {
      resolve()
    }
  }
}
