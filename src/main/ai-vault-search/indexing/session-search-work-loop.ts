import type { SessionSearchClock, SessionSearchTimerHandle } from './session-search-clock'

export type SessionSearchWorkLoopOptions = {
  clock: SessionSearchClock
  intervalMs: number
  /** Reports failures unless the task was aborted. */
  onFailure: (error: unknown) => void
}

/** Serialize passes and rearm within the chain so settled includes timer setup. */
export class SessionSearchWorkLoop {
  private timer: SessionSearchTimerHandle | null = null
  private controller: AbortController | null = null
  private chain: Promise<void> = Promise.resolve()
  private closed = false

  constructor(private readonly options: SessionSearchWorkLoopOptions) {}

  /** Includes all queued work and timer rearming; task failures go to onFailure. */
  get settled(): Promise<void> {
    return this.chain
  }

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

  /** Cancel running and queued tasks before the owner closes their resources. */
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
