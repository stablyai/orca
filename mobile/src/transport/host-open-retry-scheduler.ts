const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000] as const

type RetryState = {
  failureCount: number
  generation: number
  timer: ReturnType<typeof setTimeout> | null
}

type HostOpenRetrySchedulerOptions = {
  canRetry: (hostId: string, generation: number) => boolean
  open: (hostId: string) => void
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}

export class HostOpenRetryScheduler {
  private readonly states = new Map<string, RetryState>()
  private readonly setTimer: typeof setTimeout
  private readonly clearTimer: typeof clearTimeout

  constructor(private readonly options: HostOpenRetrySchedulerOptions) {
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
  }

  recordFailure(hostId: string, generation: number): { failureCount: number; nextDelayMs: number } {
    const previous = this.states.get(hostId)
    this.clearStateTimer(previous)
    const failureCount = (previous?.failureCount ?? 0) + 1
    const state: RetryState = { failureCount, generation, timer: null }
    this.states.set(hostId, state)
    const delayIndex = Math.min(failureCount - 1, RETRY_DELAYS_MS.length - 1)
    const nextDelayMs = RETRY_DELAYS_MS[delayIndex]
    if (!this.options.canRetry(hostId, generation)) {
      return { failureCount, nextDelayMs }
    }
    state.timer = this.setTimer(() => {
      state.timer = null
      if (this.states.get(hostId) === state && this.options.canRetry(hostId, generation)) {
        this.options.open(hostId)
      }
    }, nextDelayMs)
    return { failureCount, nextDelayMs }
  }

  expedite(hostId: string): void {
    const state = this.states.get(hostId)
    if (!state || !this.options.canRetry(hostId, state.generation)) {
      return
    }
    this.clearStateTimer(state)
    this.options.open(hostId)
  }

  recordSuccess(hostId: string): number {
    const priorFailureCount = this.states.get(hostId)?.failureCount ?? 0
    this.cancel(hostId)
    return priorFailureCount
  }

  cancel(hostId: string): void {
    this.clearStateTimer(this.states.get(hostId))
    this.states.delete(hostId)
  }

  cancelAll(): void {
    for (const state of this.states.values()) {
      this.clearStateTimer(state)
    }
    this.states.clear()
  }

  private clearStateTimer(state: RetryState | undefined): void {
    if (state?.timer !== null && state?.timer !== undefined) {
      this.clearTimer(state.timer)
      state.timer = null
    }
  }
}
