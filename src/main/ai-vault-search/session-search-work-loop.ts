import type { SessionSearchClock, SessionSearchTimerHandle } from './session-search-clock'

export type SessionSearchWorkLoopOptions = {
  clock: SessionSearchClock
  intervalMs: number
  /** A task that threw for a reason other than its own abort. */
  onFailure: (error: unknown) => void
  /** Runs after every task, aborted or not, for bookkeeping the caller owns. */
  afterTask: () => void
}

/**
 * Runs the indexer's passes one at a time, on an interval, cancellably.
 *
 * Separate from the indexer because it is the part with no opinion about
 * transcripts: a task queue that never overlaps itself, a timer that only ever
 * has one pending tick, and an abort that a pause or a close can pull. Keeping
 * the chain and the timer in one place is what makes `settled` mean "everything
 * queued so far has finished, including the re-arm".
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

  /** Queues `work` behind whatever is already running. */
  queue(work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const chained = this.chain.then(
      () => this.guard(work),
      () => this.guard(work)
    )
    this.chain = chained
    return chained
  }

  /**
   * Queues `work` and re-arms the interval once it settles. Arming inside the
   * chain, not beside it, is what lets a test advance the clock straight after
   * awaiting instead of racing the re-arm.
   */
  queueThenArm(
    work: (signal: AbortSignal) => Promise<void>,
    shouldArm: () => boolean,
    tick: () => void
  ): Promise<void> {
    const chained = this.queue(work).then(() => this.arm(shouldArm, tick))
    this.chain = chained
    return chained
  }

  /** Stops the next tick without touching the task in flight. */
  disarm(): void {
    if (this.timer !== null) {
      this.options.clock.clearTimeout(this.timer)
      this.timer = null
    }
  }

  abort(): void {
    this.controller?.abort()
  }

  close(): void {
    this.closed = true
    this.disarm()
    this.abort()
  }

  private arm(shouldArm: () => boolean, tick: () => void): void {
    if (this.closed || this.timer !== null || !shouldArm()) {
      return
    }
    this.timer = this.options.clock.setTimeout(() => {
      this.timer = null
      tick()
    }, this.options.intervalMs)
  }

  private async guard(work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.closed) {
      return
    }
    const controller = new AbortController()
    this.controller = controller
    try {
      await work(controller.signal)
    } catch (error) {
      // An aborted task is a pause, a clear or a close, never a failure.
      if (!controller.signal.aborted) {
        this.options.onFailure(error)
      }
    } finally {
      if (this.controller === controller) {
        this.controller = null
      }
      this.options.afterTask()
    }
  }
}
