// One pass at a time over saved pending work: a pass is never re-entered, wakes arriving together
// share one pass, and one timer, replaced in place, holds the next backoff.

/** At most this many rows run at once. */
const RUNNING_LIMIT = 20
/** A row whose end saved nothing (a failing database) waits this long before it runs again. */
const PARK_MS = 30_000

export class PRPendingActionDrain<Row> {
  private readonly started = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private again = false
  private queued = false
  private stopped = false
  private readonly parked = new Set<string>()
  private parkedUntil: number | null = null

  /** `readDue` returns null when nothing may run now; `nextAt` is the next backoff. */
  constructor(
    private readonly deps: {
      readDue: (limit: number, running: readonly string[]) => Row[] | null | Promise<Row[] | null>
      keyOf: (row: Row) => string
      start: (row: Row) => void
      nextAt: () => number | null | Promise<number | null>
      now: () => number
      failed?: (error: unknown) => unknown
    }
  ) {}

  /** A started row ended: free its slot and wake a pass. An end that saved nothing keeps the row
   *  reserved until the wake timer, so a persistent failure backs off instead of spinning. */
  release(row: Row, progressed: boolean): void {
    if (this.stopped) {
      return
    }
    if (progressed) {
      this.started.delete(this.deps.keyOf(row))
      this.wake()
      return
    }
    this.parked.add(this.deps.keyOf(row))
    this.parkedUntil ??= this.deps.now() + PARK_MS
    if (!this.running) {
      this.wake()
    }
  }

  private async pass(): Promise<boolean> {
    const room = RUNNING_LIMIT - this.started.size
    const due = await this.deps.readDue(Math.max(room, 0), [...this.started])
    if (this.stopped) {
      return false
    }
    // The whole batch is reserved before any member starts, so no pass can start one twice.
    due?.forEach((row) => this.started.add(this.deps.keyOf(row)))
    due?.forEach((row) => this.deps.start(row))
    return due !== null
  }

  run(): void {
    if (this.stopped) {
      return
    }
    if (this.running) {
      this.again = true
      return
    }
    this.running = true
    void this.runPasses().catch((error: unknown) => {
      this.deps.failed?.(error)
      if (!this.stopped) {
        this.schedule(this.deps.now() + PARK_MS)
      }
    })
  }

  private async runPasses(): Promise<void> {
    try {
      // Work that ends during a pass (expired rows end at once) loops it instead of recursing.
      do {
        this.again = false
        if (!(await this.pass())) {
          return
        }
      } while (this.again)
      const next = await this.deps.nextAt()
      if (!this.stopped) {
        this.schedule(next)
      }
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
    this.stopped = true
    clearTimeout(this.timer ?? undefined)
    this.timer = null
  }

  private schedule(next: number | null): void {
    clearTimeout(this.timer ?? undefined)
    this.timer = null
    const at = next === null ? this.parkedUntil : Math.min(next, this.parkedUntil ?? next)
    if (at !== null) {
      this.timer = setTimeout(
        () => {
          this.timer = null
          if (this.parkedUntil !== null && this.deps.now() >= this.parkedUntil) {
            this.parked.forEach((key) => this.started.delete(key))
            this.parked.clear()
            this.parkedUntil = null
          }
          this.run()
        },
        Math.max(1_000, at - this.deps.now())
      )
      this.timer.unref?.()
    }
  }
}
