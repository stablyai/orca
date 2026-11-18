/** Cache slow listings synchronously. Run one scan at a time plus one queued rerun; newer results win. Without demand, mark stale until ready requests a scan. */
export class CachedScan<T> {
  private value: T | null = null
  private appliedVersion = 0
  private version = 0
  private scanning: Promise<void> | null = null
  private rescanQueued = false
  private stale = false
  private readonly freshWaiters: { after: number; done: () => void }[] = []

  constructor(
    private readonly deps: {
      scan: () => Promise<T>
      /** Whether anyone reads the producer now; a scan nobody waits on is not run. */
      demand: () => boolean
      /** Runs once per applied result, after `current` returns it. */
      applied: (value: T) => void
      label: string
    }
  ) {}

  /** The last applied result; null before the first. */
  get current(): T | null {
    return this.value
  }

  request(force = false): void {
    if (!force && !this.deps.demand()) {
      this.stale = this.value !== null
      return
    }
    if (this.scanning) {
      this.rescanQueued = true
      return
    }
    const version = ++this.version
    this.stale = false
    this.scanning = this.deps
      .scan()
      .then((value) => {
        try {
          this.apply(version, value)
        } finally {
          this.settleFresh(version)
        }
      })
      .catch((error: unknown) => {
        console.warn(`[${this.deps.label}] scan failed`, error)
        this.settleFresh(version)
      })
      .finally(() => {
        this.scanning = null
        if (this.rescanQueued) {
          this.rescanQueued = false
          this.request(true)
        }
      })
  }

  /** Settles once a result not known to be stale has applied, or the scan failed. Never rejects. */
  async ready(): Promise<void> {
    if (this.value === null || this.stale) {
      this.request(true)
    }
    while (this.scanning && (this.value === null || this.stale)) {
      await this.scanning
    }
  }

  /** Calls `done` once a scan started after this call has finished; at once with no demand. */
  afterFresh(done: () => void): void {
    if (!this.deps.demand()) {
      done()
      return
    }
    this.freshWaiters.push({ after: this.version, done })
    this.request(true)
  }

  // Why synchronous after apply: a waiter's change lands in the same revision as the result.
  private settleFresh(version: number): void {
    const due = this.freshWaiters.filter((waiter) => waiter.after < version)
    if (due.length === 0) {
      return
    }
    const waiting = this.freshWaiters.filter((waiter) => waiter.after >= version)
    this.freshWaiters.splice(0, this.freshWaiters.length, ...waiting)
    for (const waiter of due) {
      waiter.done()
    }
  }

  /** Settles once every scan requested so far has applied; for one-shot readers. */
  async settled(): Promise<void> {
    await this.ready()
    while (this.scanning) {
      await this.scanning
    }
  }

  private apply(version: number, value: T): void {
    // A scan older than the one applied never replaces it.
    if (version <= this.appliedVersion) {
      return
    }
    this.appliedVersion = version
    this.value = value
    this.deps.applied(value)
  }
}
