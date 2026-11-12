import type { DerivedImageLease } from './terminal-history-derived-image'
import type { TerminalSessionJournal } from './terminal-session-journal'
import type { TerminalHistoryImage } from './terminal-session-journal-contract'
import {
  HistoryFlight,
  type FlightInterest,
  type TerminalHistoryReads
} from './terminal-history-read-admission'

/**
 * One request's admitted record: its deadline signal, its interest in a flight and its image
 * lease. Released once, when its reply settles or it is abandoned before writing.
 */
export class HistoryReadConsumer {
  private lease: DerivedImageLease | null = null
  private interest: FlightInterest | null = null
  key: string | null = null
  private released = false

  constructor(
    private readonly reads: TerminalHistoryReads,
    readonly signal: AbortSignal,
    private readonly onRelease: () => void
  ) {}

  get image(): TerminalHistoryImage | null {
    return this.lease?.image ?? null
  }

  /**
   * An exact image for the journal's current cut and shape, or a flight this consumer leads and
   * must capture. Every wait rechecks the latest result and flight; one deadline governs all.
   */
  async acquire(
    journal: TerminalSessionJournal,
    scrollbackRows: number | undefined,
    barrier: () => Promise<void>
  ): Promise<HistoryFlight | 'image' | null> {
    for (;;) {
      await this.untilAborted(barrier())
      const found = this.findSync(journal, scrollbackRows)
      if (found === 'joined') {
        // A failed or revoked flight is this read's answer too; it does not reconstruct again.
        return (await this.awaitInterest()) ? 'image' : null
      }
      if (found !== 'miss') {
        return found
      }
      const lane = await this.reads.waitLane(this.signal)
      if (lane === 'published') {
        // Join at publication so a short flight cannot finish unseen; the barrier then proves it.
        const flight = this.key ? this.reads.current(journal, this.key) : null
        if (!flight) {
          continue
        }
        this.interest = flight.join()
        try {
          await this.untilAborted(barrier())
        } catch (error) {
          this.dropImage()
          throw error
        }
        if (journal.derivedKey(scrollbackRows) !== flight.key) {
          this.dropImage()
          continue
        }
        return (await this.awaitInterest()) ? 'image' : null
      }
      let releaseReplay: (() => void) | null = null
      try {
        // The cut is captured after the lane wait, so its barrier settles again first.
        await this.untilAborted(barrier())
        const afterLane = this.findSync(journal, scrollbackRows)
        if (afterLane !== 'miss') {
          lane()
          return afterLane === 'joined'
            ? (await this.awaitInterest())
              ? 'image'
              : null
            : afterLane
        }
        releaseReplay = await journal.acquireRead(this.signal)
        this.signal.throwIfAborted()
      } catch (error) {
        releaseReplay?.()
        lane()
        throw error
      }
      const flight = new HistoryFlight(this.reads, journal, scrollbackRows, lane, releaseReplay)
      this.interest = flight.join()
      return flight
    }
  }

  /** The leader's result after its capture; false when reconstruction produced nothing. */
  async awaitFlight(flight: HistoryFlight): Promise<boolean> {
    this.key = flight.key
    return this.awaitInterest()
  }

  /** Drops the image for a changed-cut retry while keeping this consumer's admission. */
  dropImage(): void {
    this.lease?.release()
    this.lease = null
    this.interest?.leave()
    this.interest = null
  }

  release(): void {
    if (!this.released) {
      this.released = true
      this.dropImage()
      this.onRelease()
    }
  }

  private findSync(
    journal: TerminalSessionJournal,
    scrollbackRows: number | undefined
  ): 'image' | 'joined' | 'miss' | null {
    const key = journal.derivedKey(scrollbackRows)
    if (!key) {
      return null
    }
    this.key = key
    this.lease = journal.leaseDerived(key)
    if (this.lease) {
      return 'image'
    }
    const flight = this.reads.current(journal, key)
    if (!flight) {
      return 'miss'
    }
    this.interest = flight.join()
    return 'joined'
  }

  private async awaitInterest(): Promise<boolean> {
    const interest = this.interest!
    try {
      const lease = await this.untilAborted(interest.result)
      if (!lease) {
        // A failed join leaves only this interest; others keep theirs.
        interest.leave()
        this.interest = null
        return false
      }
      this.interest = null
      this.lease = lease
      return true
    } catch (error) {
      // Withdraws only this participant, whether the abort came before or during the wait.
      interest.leave()
      this.interest = null
      throw error
    }
  }

  /**
   * Waits for work this consumer does not own while honouring its one deadline, including an
   * abort that already happened. The awaited work itself continues for its other owners.
   */
  private async untilAborted<T>(work: Promise<T>): Promise<T> {
    this.signal.throwIfAborted()
    const aborted = Promise.withResolvers<never>()
    const onAbort = (): void => aborted.reject(this.signal.reason)
    this.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const value = await Promise.race([work, aborted.promise])
      this.signal.throwIfAborted()
      return value
    } finally {
      this.signal.removeEventListener('abort', onAbort)
    }
  }
}
