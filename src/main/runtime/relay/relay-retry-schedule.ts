import { computeRetryDelayMs } from './relay-retry-backoff'

// One armed retry at a time with jittered exponential backoff. `settled` lets a
// waiter sit through the armed retry instead of reading "nothing is running" as
// "nothing more is coming": it resolves when the retry fires or is cancelled.
export class RelayRetrySchedule {
  private timer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private armed: PromiseWithResolvers<void> | null = null

  constructor(private readonly random: () => number = Math.random) {}

  get pending(): boolean {
    return this.timer !== null
  }

  get settled(): Promise<void> | null {
    return this.armed?.promise ?? null
  }

  schedule(retryAfterMs: number, retry: () => void): void {
    if (this.timer) {
      return
    }
    const delayMs = computeRetryDelayMs(this.attempt++, retryAfterMs, this.random)
    const armed = Promise.withResolvers<void>()
    this.armed = armed
    this.timer = setTimeout(() => {
      this.timer = null
      this.armed = null
      retry()
      armed.resolve()
    }, delayMs)
  }

  reset(): void {
    this.attempt = 0
  }

  // Why the waiter is woken rather than left parked: a cancelled retry is
  // superseded by a fresh reconcile (or a fence), and the waiter must re-check.
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const armed = this.armed
    this.armed = null
    armed?.resolve()
  }
}
