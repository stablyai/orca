/**
 * Four reader workers bound concurrency, not memory: every queued request still becomes a reply
 * that main must hold. Admission bounds how many requests are out at once and the reply bytes
 * they may carry, so replies cannot pile up faster than main consumes them.
 */
export const JOURNAL_READER_ADMITTED_READS = 8
export const JOURNAL_READER_ADMITTED_BYTES = 32 * 2 ** 20
/** Reads without a page budget (points, metadata, receipts) answer with small replies. */
export const JOURNAL_READER_DEFAULT_REPLY_BYTES = 256 * 2 ** 10

export type JournalReaderTicket = {
  /** The reply reached main. */
  received(): void
  /** Main finished with the reply; its credit returns to waiting reads. */
  consumed(): void
}

type Waiter = {
  bytes: number
  since: number
  admit: (ticket: JournalReaderTicket) => void
}

export type JournalReaderAdmissionStats = {
  /** Requests a worker holds whose reply main has not received. */
  inFlight: number
  /** Replies main received but has not finished with. */
  unconsumed: number
  waiting: number
  oldestWaitMs: number
  reservedBytes: number
  /** Cumulative reply credit, at each read's reserved size. */
  receivedBytes: number
  consumedBytes: number
}

export class JournalReaderAdmission {
  private inFlight = 0
  private unconsumed = 0
  private reservedBytes = 0
  private receivedBytes = 0
  private consumedBytes = 0
  private readonly waiting = new Set<Waiter>()

  constructor(
    private readonly reads = JOURNAL_READER_ADMITTED_READS,
    private readonly bytes = JOURNAL_READER_ADMITTED_BYTES,
    private readonly now: () => number = Date.now
  ) {}

  /** FIFO; a read larger than the whole budget still runs alone. Aborting withdraws a waiting read. */
  admit(bytes: number, signal?: AbortSignal): Promise<JournalReaderTicket> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason)
    }
    if (this.waiting.size === 0 && this.fits(bytes)) {
      return Promise.resolve(this.ticket(bytes))
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        bytes,
        since: this.now(),
        admit: (ticket) => {
          signal?.removeEventListener('abort', withdraw)
          resolve(ticket)
        }
      }
      const withdraw = () => {
        if (this.waiting.delete(waiter)) {
          reject(signal?.reason)
          this.admitWaiting()
        }
      }
      signal?.addEventListener('abort', withdraw, { once: true })
      this.waiting.add(waiter)
    })
  }

  stats(): JournalReaderAdmissionStats {
    const oldest = this.waiting.values().next()
    return {
      inFlight: this.inFlight,
      unconsumed: this.unconsumed,
      waiting: this.waiting.size,
      oldestWaitMs: oldest.done ? 0 : this.now() - oldest.value.since,
      reservedBytes: this.reservedBytes,
      receivedBytes: this.receivedBytes,
      consumedBytes: this.consumedBytes
    }
  }

  private fits(bytes: number): boolean {
    const outstanding = this.inFlight + this.unconsumed
    return (
      outstanding === 0 || (outstanding < this.reads && this.reservedBytes + bytes <= this.bytes)
    )
  }

  private ticket(bytes: number): JournalReaderTicket {
    this.inFlight += 1
    this.reservedBytes += bytes
    let state: 'in-flight' | 'received' | 'consumed' = 'in-flight'
    const consumed = () => {
      if (state === 'consumed') {
        return
      }
      if (state === 'in-flight') {
        this.inFlight -= 1
      } else {
        this.unconsumed -= 1
        this.consumedBytes += bytes
      }
      state = 'consumed'
      this.reservedBytes -= bytes
      this.admitWaiting()
    }
    return {
      received: () => {
        if (state === 'in-flight') {
          state = 'received'
          this.inFlight -= 1
          this.unconsumed += 1
          this.receivedBytes += bytes
        }
      },
      consumed
    }
  }

  private admitWaiting(): void {
    for (const waiter of this.waiting) {
      if (!this.fits(waiter.bytes)) {
        return
      }
      this.waiting.delete(waiter)
      waiter.admit(this.ticket(waiter.bytes))
    }
  }
}
