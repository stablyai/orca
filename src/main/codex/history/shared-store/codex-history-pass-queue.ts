/**
 * Runs history passes one at a time (homes merging into one store at once would race on its
 * folders). A pass a launch waits on goes ahead of queued background ones: a launch waits only
 * for its own home, not for every other account's migration queued before it.
 */
export class CodexHistoryPassQueue {
  private readonly launches: (() => Promise<void>)[] = []
  private readonly background: (() => Promise<void>)[] = []
  private running = false

  add<T>(work: () => Promise<T>, options: { forLaunch: boolean }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job = (): Promise<void> => work().then(resolve, reject)
      ;(options.forLaunch ? this.launches : this.background).push(job)
      void this.drain()
    })
  }

  private async drain(): Promise<void> {
    if (this.running) {
      return
    }
    this.running = true
    try {
      for (
        let job = this.launches.shift() ?? this.background.shift();
        job;
        job = this.launches.shift() ?? this.background.shift()
      ) {
        await job()
      }
    } finally {
      this.running = false
    }
  }
}

/**
 * One pass per home at a time, queued per store: a request joins the pass already queued for that
 * home in that mode, unless a launch needs it and that one would wait behind others. The newest
 * request owns the home: an older pass still queued is skipped, so it can't undo a newer setting,
 * and its waiters wait for the pass that replaced it.
 */
export class CodexHistoryPassRequests {
  private readonly latest = new Map<
    string,
    { shared: boolean; forLaunch: boolean; pass: Promise<void> }
  >()
  private readonly queues = new Map<string, CodexHistoryPassQueue>()
  private readonly newest = new Map<string, { pass?: Promise<void> }>()

  /** Whether a pass for the home is queued or running. */
  has(home: string): boolean {
    return this.latest.has(home)
  }

  request(
    target: { queue: string; home: string; shared: boolean; forLaunch: boolean },
    work: () => Promise<void>
  ): Promise<void> {
    const { home, shared } = target
    const previous = this.latest.get(home)
    if (previous?.shared === shared && (previous.forLaunch || !target.forLaunch)) {
      return previous.pass
    }
    // A launch waiting on the pass this one replaces keeps its priority.
    const forLaunch = target.forLaunch || previous?.forLaunch === true
    const queue = this.queues.get(target.queue) ?? new CodexHistoryPassQueue()
    this.queues.set(target.queue, queue)
    const owner: { pass?: Promise<void> } = {}
    // Set before queueing: an idle queue starts the job at once.
    this.newest.set(home, owner)
    const isNewest = (): boolean => this.newest.get(home) === owner
    const ran = queue.add(
      async () => {
        if (!isNewest()) {
          return false
        }
        await work()
        return true
      },
      { forLaunch }
    )
    // Chained outside the queue: a skipped pass waiting inside it would block the newer one.
    const pass = ran.then((done) => (done ? undefined : this.newest.get(home)?.pass))
    owner.pass = pass
    this.latest.set(home, { shared, forLaunch, pass })
    void pass
      .finally(() => {
        if (this.latest.get(home)?.pass === pass) {
          this.latest.delete(home)
        }
        if (isNewest()) {
          this.newest.delete(home)
        }
      })
      .catch(() => {})
    return pass
  }
}
