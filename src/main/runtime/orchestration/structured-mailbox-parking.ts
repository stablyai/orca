/** Mailboxes waiting for their chat's next journal edge, indexed by that chat, and the journal watch each
 *  such chat keeps only while it has one. */

export type ParkedMailbox = {
  sessionId: string
  reservedTypes: ReadonlySet<string> | undefined
}

export class StructuredMailboxParking {
  /** Retain the parked session id: transient resolution failure must not erase unrelated workers' retry edges. */
  private readonly parked = new Map<string, Map<string, ParkedMailbox>>()
  private readonly sessionOf = new Map<string, string>()
  /** Sessions with parked mail hear their own journal, coordinators included, not only status edges. */
  private readonly watches = new Map<string, () => void>()

  constructor(
    private readonly deps: {
      /** Coalesced journal publications of a session; returns the unsubscribe. */
      watchJournal: (sessionId: string, onActivity: () => void) => () => void
      onActivity: (sessionId: string) => void
    }
  ) {}

  park(mailboxHandle: string, sessionId: string, reservedTypes?: ReadonlySet<string>): void {
    if (this.sessionOf.get(mailboxHandle) !== sessionId) {
      this.unpark(mailboxHandle)
    }
    const own = this.parked.get(sessionId) ?? new Map<string, ParkedMailbox>()
    own.set(mailboxHandle, { sessionId, reservedTypes })
    this.parked.set(sessionId, own)
    this.sessionOf.set(mailboxHandle, sessionId)
    if (!this.watches.has(sessionId)) {
      this.watches.set(
        sessionId,
        this.deps.watchJournal(sessionId, () => this.onWatched(sessionId))
      )
    }
  }

  /** A session's watch ends with its last parked mailbox, retargeted ones included. */
  unpark(mailboxHandle: string): void {
    const sessionId = this.sessionOf.get(mailboxHandle)
    if (sessionId === undefined) {
      return
    }
    this.sessionOf.delete(mailboxHandle)
    const own = this.parked.get(sessionId)
    own?.delete(mailboxHandle)
    if (!own?.size) {
      this.forget(sessionId)
    }
  }

  clear(): void {
    for (const sessionId of this.watches.keys()) {
      this.forget(sessionId)
    }
  }

  parkedFor(sessionId: string): [string, ParkedMailbox][] {
    return Array.from(this.parked.get(sessionId) ?? [])
  }

  forget(sessionId: string): void {
    for (const mailboxHandle of this.parked.get(sessionId)?.keys() ?? []) {
      this.sessionOf.delete(mailboxHandle)
    }
    this.parked.delete(sessionId)
    this.watches.get(sessionId)?.()
    this.watches.delete(sessionId)
  }

  /** A queue freeing room or a card changing is a journal edge, not a status edge. */
  private onWatched(sessionId: string): void {
    try {
      this.deps.onActivity(sessionId)
    } catch {
      // A database closing under shutdown: the mail stays for the next start's scan.
    }
  }
}
