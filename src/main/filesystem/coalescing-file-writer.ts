const RETRY_MIN_MS = 1_000
const RETRY_MAX_MS = 30_000

/**
 * Saves a file's newest state off the main thread: one commit at a time, and while it runs only
 * the newest state waits behind it. A running commit is never cut short, so under steady changes
 * every commit still lands, newest next. A failed commit retries with backoff until a newer save.
 */
export class CoalescingFileWriter<T> {
  // The newest state not yet on disk; undefined once the file holds it.
  private wanted: T | undefined
  // Bumped by every save, so a drain sees a newer state arrived while it wrote.
  private generation = 0
  private running: Promise<void> | null = null
  // Ends a retry's wait early: a new save tries at once, and quit tries once more.
  private wake: (() => void) | null = null
  // Settling for quit: a failure ends the drain rather than wait out a backoff, once an attempt
  // started after quit began (numbered past `quitFrom`) has failed too.
  private quitting = false
  private attempts = 0
  private quitFrom = 0
  // The last drain stopped on a failure while quitting; only a new save starts another.
  private gaveUp = false
  // Callers waiting for the state saved as `generation` (or a newer one) to land or fail.
  private waiters: { generation: number; settle: (landed: boolean) => void }[] = []

  /** `commit` resolves false on a failure it has reported; a rejection counts as one too. */
  constructor(private readonly commit: (state: T) => Promise<boolean>) {}

  /** What a reader must use instead of the file while it hasn't landed. */
  get pending(): T | undefined {
    return this.wanted
  }

  save(state: T): void {
    this.wanted = state
    this.generation += 1
    this.gaveUp = false
    this.wake?.()
    this.run()
  }

  /** True once what is queued (or newer) is on disk; false at the first failed attempt to save it.
   *  A failure keeps retrying in the background either way. */
  landed(): Promise<boolean> {
    if (this.wanted === undefined) {
      return Promise.resolve(true)
    }
    // Quit gave up on it and nothing retries until a new save.
    if (this.gaveUp) {
      return Promise.resolve(false)
    }
    // Someone is waiting: retry now instead of after the backoff.
    this.wake?.()
    return new Promise((settle) => this.waiters.push({ generation: this.generation, settle }))
  }

  /** For quit: what is queued lands, and a failing save gets one more try instead of its backoff. */
  async settled(): Promise<void> {
    this.quitting = true
    this.quitFrom = this.attempts
    try {
      this.wake?.()
      if (this.wanted !== undefined) {
        this.gaveUp = false
        this.run()
      }
      while (this.running) {
        await this.running
      }
    } finally {
      this.quitting = false
    }
  }

  private run(): void {
    this.running ??= this.drain().finally(() => {
      this.running = null
      // A save that came in as the drain finished.
      if (this.wanted !== undefined && !this.gaveUp) {
        this.run()
      }
    })
  }

  private async drain(): Promise<void> {
    let retryMs = 0
    while (this.wanted !== undefined) {
      const { wanted, generation } = this
      const attempt = ++this.attempts
      const landed = await this.commit(wanted).catch(() => false)
      this.settleWaiters(generation, landed)
      if (generation !== this.generation) {
        continue
      }
      if (landed) {
        this.wanted = undefined
        return
      }
      // Kept wanted, so no reader in this process falls back to the stale file.
      if (this.quitting) {
        if (attempt > this.quitFrom) {
          this.gaveUp = true
          return
        }
        continue
      }
      retryMs = Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, retryMs * 2))
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, retryMs)
        this.wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      this.wake = null
    }
  }

  private settleWaiters(generation: number, landed: boolean): void {
    const settled = this.waiters.filter((waiter) => waiter.generation <= generation)
    if (settled.length === 0) {
      return
    }
    this.waiters = this.waiters.filter((waiter) => waiter.generation > generation)
    for (const waiter of settled) {
      waiter.settle(landed)
    }
  }
}
