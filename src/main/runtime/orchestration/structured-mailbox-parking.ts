/** Mailboxes waiting for their chat's next journal edge, and the journal watch each such chat keeps. */

export type ParkedMailbox = {
  sessionId: string
  reservedTypes: ReadonlySet<string> | undefined
}

export class StructuredMailboxParking {
  /** Retain the parked session id: transient resolution failure must not erase unrelated workers' retry edges. */
  private readonly parked = new Map<string, ParkedMailbox>()
  /** Sessions with parked mail hear their own journal, coordinators included, not only status edges. */
  private readonly watches = new Map<string, () => void>()

  constructor(
    private readonly deps: {
      /** Coalesced journal publications of a session; returns the unsubscribe. */
      watchJournal: (sessionId: string, onActivity: () => void) => () => void
      onActivity: (sessionId: string) => void
      /** A pass is running and may park again. */
      busy: () => boolean
    }
  ) {}

  park(mailboxHandle: string, sessionId: string, reservedTypes?: ReadonlySet<string>): void {
    this.parked.set(mailboxHandle, { sessionId, reservedTypes })
    if (!this.watches.has(sessionId)) {
      this.watches.set(
        sessionId,
        this.deps.watchJournal(sessionId, () => this.onWatched(sessionId))
      )
    }
  }

  unpark(mailboxHandle: string): void {
    this.parked.delete(mailboxHandle)
  }

  parkedFor(sessionId: string): [string, ParkedMailbox][] {
    return Array.from(this.parked).filter(([, parked]) => parked.sessionId === sessionId)
  }

  forget(sessionId: string): void {
    for (const [mailboxHandle] of this.parkedFor(sessionId)) {
      this.parked.delete(mailboxHandle)
    }
    this.unwatch(sessionId)
  }

  /** A queue freeing room or a card changing is a journal edge, not a status edge. */
  private onWatched(sessionId: string): void {
    if (this.parkedFor(sessionId).length > 0) {
      try {
        this.deps.onActivity(sessionId)
      } catch {
        // A database closing under shutdown: the mail stays for the next start's scan.
      }
      return
    }
    // Nothing parked here any more: the watch ends with it, unless a pass may park again.
    if (!this.deps.busy()) {
      this.unwatch(sessionId)
    }
  }

  private unwatch(sessionId: string): void {
    this.watches.get(sessionId)?.()
    this.watches.delete(sessionId)
  }
}
