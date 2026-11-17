/**
 * Four reader workers bound concurrency, not outstanding requests: every request posted at once
 * becomes a reply main must hold. Each reader admits this many reads at a time in FIFO, so the
 * pool has at most eight out and a slow read holds only its own reader's share while least-pending
 * selection steers new reads elsewhere. Reply bytes are bounded separately by the reply credit.
 */
export const JOURNAL_READER_ADMITTED_READS = 2

export type JournalReaderTicket = {
  /** The reply reached main, carrying `bytes` when its reader charged it. */
  received(bytes: number): void
  /** Main finished with the reply, or the read ended without one. */
  consumed(): void
}

type Waiter = { since: number; admit: (ticket: JournalReaderTicket) => void }

export type JournalReaderAdmissionStats = {
  /** Requests a reader holds whose reply main has not received. */
  inFlight: number
  /** Replies main received but has not finished with. */
  unconsumed: number
  waiting: number
  oldestWaitMs: number
  /** Cumulative charged reply bytes. */
  receivedBytes: number
  consumedBytes: number
  /** Replies a reader posted after giving up waiting for credit: a leak or a stuck main. */
  creditWaitsExpired: number
}

export class JournalReaderAdmission {
  private inFlight = 0
  private unconsumed = 0
  private receivedBytes = 0
  private consumedBytes = 0
  private creditWaitsExpired = 0
  private readonly waiting = new Set<Waiter>()

  constructor(
    private readonly reads = JOURNAL_READER_ADMITTED_READS,
    private readonly now: () => number = Date.now
  ) {}

  /** Aborting withdraws a read still waiting; one already admitted runs to its reply. */
  admit(signal?: AbortSignal): Promise<JournalReaderTicket> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason)
    }
    if (this.waiting.size === 0 && this.fits()) {
      return Promise.resolve(this.ticket())
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        since: this.now(),
        admit: (ticket) => {
          signal?.removeEventListener('abort', withdraw)
          resolve(ticket)
        }
      }
      const withdraw = () => {
        if (this.waiting.delete(waiter)) {
          reject(signal?.reason)
        }
      }
      signal?.addEventListener('abort', withdraw, { once: true })
      this.waiting.add(waiter)
    })
  }

  creditWaitExpired(): void {
    this.creditWaitsExpired += 1
  }

  stats(): JournalReaderAdmissionStats {
    const oldest = this.waiting.values().next()
    return {
      inFlight: this.inFlight,
      unconsumed: this.unconsumed,
      waiting: this.waiting.size,
      oldestWaitMs: oldest.done ? 0 : this.now() - oldest.value.since,
      receivedBytes: this.receivedBytes,
      consumedBytes: this.consumedBytes,
      creditWaitsExpired: this.creditWaitsExpired
    }
  }

  private fits(): boolean {
    return this.inFlight + this.unconsumed < this.reads
  }

  private ticket(): JournalReaderTicket {
    this.inFlight += 1
    let state: 'in-flight' | 'received' | 'consumed' = 'in-flight'
    let charged = 0
    return {
      received: (bytes) => {
        if (state === 'in-flight') {
          state = 'received'
          charged = bytes
          this.inFlight -= 1
          this.unconsumed += 1
          this.receivedBytes += bytes
        }
      },
      consumed: () => {
        if (state === 'consumed') {
          return
        }
        if (state === 'in-flight') {
          this.inFlight -= 1
        } else {
          this.unconsumed -= 1
          this.consumedBytes += charged
        }
        state = 'consumed'
        this.admitWaiting()
      }
    }
  }

  private admitWaiting(): void {
    for (const waiter of this.waiting) {
      if (!this.fits()) {
        return
      }
      this.waiting.delete(waiter)
      waiter.admit(this.ticket())
    }
  }
}
