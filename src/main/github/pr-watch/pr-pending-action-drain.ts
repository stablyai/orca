// One pass at a time over saved pending work: a pass is never re-entered, wakes arriving together
// share one pass, and one timer, replaced in place, holds the next backoff.

/** At most this many rows run at once. */
const RUNNING_LIMIT = 20

export class PRPendingActionDrain<Row> {
  private readonly started = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private again = false
  private queued = false

  /** `readDue` returns null when nothing may run now; `nextAt` is the next backoff. */
  constructor(
    private readonly deps: {
      readDue: (limit: number, running: readonly string[]) => Row[] | null
      keyOf: (row: Row) => string
      start: (row: Row) => void
      nextAt: () => number | null
      now: () => number
    }
  ) {}

  /** A started row ended: free its slot and wake a pass. */
  release(row: Row): void {
    this.started.delete(this.deps.keyOf(row))
    this.wake()
  }

  private pass(): boolean {
    const room = RUNNING_LIMIT - this.started.size
    const due = this.deps.readDue(Math.max(room, 0), [...this.started])
    // The whole batch is reserved before any member starts, so no pass can start one twice.
    due?.forEach((row) => this.started.add(this.deps.keyOf(row)))
    due?.forEach((row) => this.deps.start(row))
    return due !== null
  }

  run(): void {
    if (this.running) {
      this.again = true
      return
    }
    this.running = true
    try {
      // Work that ends during a pass (expired rows end at once) loops it instead of recursing.
      do {
        this.again = false
        if (!this.pass()) {
          return
        }
      } while (this.again)
      this.schedule(this.deps.nextAt())
    } finally {
      this.running = false
    }
  }

  /** One pass for every completion arriving together. */
  private wake(): void {
    if (this.running) {
      this.again = true
    } else if (!this.queued) {
      this.queued = true
      queueMicrotask(() => {
        this.queued = false
        this.run()
      })
    }
  }

  stop(): void {
    this.schedule(null)
  }

  private schedule(at: number | null): void {
    clearTimeout(this.timer ?? undefined)
    this.timer = null
    if (at !== null) {
      this.timer = setTimeout(
        () => {
          this.timer = null
          this.run()
        },
        Math.max(1_000, at - this.deps.now())
      )
      this.timer.unref?.()
    }
  }
}
