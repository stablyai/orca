import type { SessionSearchClock, SessionSearchTimerHandle } from './session-search-clock'

export type SessionSearchWorkLoopOptions = {
  clock: SessionSearchClock
  intervalMs: number
  /** A task that threw for a reason other than its own abort. */
  onFailure: (error: unknown) => void
}

/**
 * Runs the indexer's passes one at a time, on an interval, until it is closed.
 *
 * Separate from the indexer because it is the part with no opinion about
 * transcripts: a task chain that never overlaps itself, a timer that only ever
 * has one pending tick, and a close that cancels both. Arming inside the chain
 * rather than beside it is what makes `settled` mean "everything queued so far
 * has finished, including the re-arm", which is what a fake-clock test needs.
 */
export class SessionSearchWorkLoop {
  private timer: SessionSearchTimerHandle | null = null
  private controller: AbortController | null = null
  private chain: Promise<void> = Promise.resolve()
  private closed = false

  constructor(private readonly options: SessionSearchWorkLoopOptions) {}

  /** Everything queued so far. Never rejects: a task's failure is reported, not thrown. */
  get settled(): Promise<void> {
    return this.chain
  }

  /** Queues `work` behind whatever is running, then re-arms the interval. */
  queue(work: (signal: AbortSignal) => Promise<void>, tick: () => void): Promise<void> {
    const chained = this.chain
      .then(
        () => this.run(work),
        () => this.run(work)
      )
      .then(() => this.arm(tick))
    this.chain = chained
    return chained
  }

  /**
   * Stops the timer, the task in flight and everything queued behind it. Nothing
   * queued before this call may run afterwards: that is what lets the indexer
   * close its store here and know no pass will reach for it.
   */
  close(): void {
    this.closed = true
    if (this.timer !== null) {
      this.options.clock.clearTimeout(this.timer)
      this.timer = null
    }
    this.controller?.abort()
  }

  private arm(tick: () => void): void {
    if (this.closed || this.timer !== null) {
      return
    }
    this.timer = this.options.clock.setTimeout(() => {
      this.timer = null
      tick()
    }, this.options.intervalMs)
  }

  private async run(work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.closed) {
      return
    }
    const controller = new AbortController()
    this.controller = controller
    try {
      await work(controller.signal)
    } catch (error) {
      // An aborted task is a close, never a failure.
      if (!controller.signal.aborted) {
        this.options.onFailure(error)
      }
    } finally {
      if (this.controller === controller) {
        this.controller = null
      }
    }
  }
}
