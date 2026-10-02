// The runtime's share of startup chat work: startup restoration until its first try has settled,
// the first tab listing until it has answered, tab listings in flight, and the history restore a
// listing owes until it has started. The background copy of old chat files waits while any of it
// runs, so it never competes with the first paint. Each is cleared in the same code that does the
// work, so nothing here can strand; the first listing alone has a bounded wait.

/** How long the copy waits for a first tab listing to answer: a host no client lists (an orcad no
 *  client attaches to, a headless host) still copies. Past a slow first window's paint. */
export const STARTUP_FIRST_LISTING_WAIT_MS = 60_000

export class StructuredAgentSessionStartupChatWork {
  private restorationPrepared = false
  private listings = 0
  private listed = false
  private readonly startedAt: number

  constructor(private readonly now: () => number = () => Date.now()) {
    this.startedAt = now()
  }
  /** The history restore a tab restore owes, until a caller that answered with its list starts it. */
  private owedRestore: (() => void) | null = null
  private restoreStarting = false

  /** Every host prepares restoration (desktop once the first window's services are up or at their
   *  12 s timeout, a headless host at once) and the first tab listing waits for it, so its first
   *  try settling, resolved or not, is when listings can start. */
  async trackRestorationPrepare(prepare: () => Promise<void>): Promise<void> {
    try {
      await prepare()
    } finally {
      this.restorationPrepared = true
    }
  }

  async trackListing(listing: () => Promise<void>): Promise<void> {
    this.listings += 1
    try {
      await listing()
      this.listed = true
    } finally {
      this.listings -= 1
    }
  }

  oweRestore(restore: (() => void) | null): void {
    this.owedRestore = restore
  }

  /** Starts the owed history restore, once, on the next macrotask, and counts as work until it has:
   *  the host then reports the restore itself. */
  startOwedRestoreSoon(): void {
    const start = this.owedRestore
    this.owedRestore = null
    if (!start) {
      return
    }
    this.restoreStarting = true
    setImmediate(() => {
      this.restoreStarting = false
      start()
    })
  }

  isActive = (): boolean =>
    !this.restorationPrepared ||
    (!this.listed && this.now() - this.startedAt < STARTUP_FIRST_LISTING_WAIT_MS) ||
    this.listings > 0 ||
    this.restoreStarting ||
    this.owedRestore !== null
}
