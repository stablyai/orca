import { PrioritySemaphore } from '../../../../shared/priority-semaphore'
import { DerivedHistoryImageBudget, type DerivedImageLease } from './terminal-history-derived-image'
import type { TerminalSessionJournal } from './terminal-session-journal'
import { HistoryReadConsumer } from './terminal-history-read-consumer'
import type {
  TerminalHistoryImage,
  TerminalHistoryReadCut
} from './terminal-session-journal-contract'

/** Admitted deep-history consumers host-wide, waiting, joined and writing alike. */
export const HISTORY_READ_CONSUMERS = 64

/** Whether the host's writers plus this many frozen read bytes stay within the host bound. */
type FitsReadSource = (frozenBytes: number) => boolean

/**
 * Host owner of deep-history reads: bounded consumers, the derived-image budget, one cold lane
 * and the single flight it guards, and the charge for that flight's frozen pending source.
 */
export class TerminalHistoryReads {
  private consumers = 0
  private readonly lane = new PrioritySemaphore(1)
  private flight: HistoryFlight | null = null
  private readonly wakers = new Set<() => void>()
  private readonly severs = new Set<() => void>()
  private readonly sources = new Set<TerminalSessionJournal>()

  constructor(
    private readonly fits: FitsReadSource,
    readonly images = new DerivedHistoryImageBudget()
  ) {}

  /** Frozen read backing no longer shared with any writer, counted once. */
  get readSourceBytes(): number {
    let bytes = 0
    for (const journal of this.sources) {
      bytes += journal.frozenBytes
    }
    return bytes
  }

  /** A consumer record held until its reply settles; null when all are taken. */
  admit(signal: AbortSignal): HistoryReadConsumer | null {
    if (this.consumers >= HISTORY_READ_CONSUMERS) {
      return null
    }
    this.consumers += 1
    return new HistoryReadConsumer(this, signal, () => {
      this.consumers -= 1
    })
  }

  /** Writer pressure severs every read source before any healthy writer is gapped. */
  relievePressure(): void {
    for (const sever of Array.from(this.severs)) {
      sever()
    }
  }

  /** Reserves before the copy; release follows the severing of every reference into it. */
  reserveSource(journal: TerminalSessionJournal, sever: () => void): (() => void) | null {
    const release = journal.holdFrozenSource(sever, (bytes) =>
      this.fits(this.readSourceBytes + bytes)
    )
    if (!release) {
      return null
    }
    this.sources.add(journal)
    this.severs.add(sever)
    return () => {
      this.severs.delete(sever)
      this.sources.delete(journal)
      release()
    }
  }

  current(journal: TerminalSessionJournal, key: string): HistoryFlight | null {
    const flight = this.flight
    return flight?.joinable(journal, key) ? flight : null
  }

  publish(flight: HistoryFlight): void {
    this.flight = flight
    for (const wake of Array.from(this.wakers)) {
      wake()
    }
  }

  retire(flight: HistoryFlight): void {
    if (this.flight === flight) {
      this.flight = null
    }
  }

  /** The cold lane, or 'published' when a flight appears that this waiter may join instead. */
  async waitLane(signal: AbortSignal): Promise<(() => void) | 'published'> {
    const wake = new AbortController()
    const waker = (): void => wake.abort()
    this.wakers.add(waker)
    try {
      return await this.lane.acquire(1, AbortSignal.any([signal, wake.signal]))
    } catch (error) {
      if (wake.signal.aborted && !signal.aborted) {
        return 'published'
      }
      throw error
    } finally {
      this.wakers.delete(waker)
    }
  }
}

export type FlightInterest = {
  readonly result: Promise<DerivedImageLease | null>
  leave(): void
}

/**
 * One cold reconstruction shared by every consumer of the same exact cut and shape. It owns the
 * cut, the revocable pending source, the replay lease and the result; consumers own only their
 * interests. Joining closes at reconstruction completion.
 */
export class HistoryFlight {
  key: string | null = null
  private cut: TerminalHistoryReadCut | null = null
  private closed = false
  private releaseSource: (() => void) | null = null
  private readonly controller = new AbortController()
  private readonly interests = new Set<(lease: DerivedImageLease | null) => void>()

  constructor(
    private readonly reads: TerminalHistoryReads,
    private readonly journal: TerminalSessionJournal,
    private readonly scrollbackRows: number | undefined,
    private releaseLane: (() => void) | null,
    private releaseReplay: (() => void) | null
  ) {}

  joinable(journal: TerminalSessionJournal, key: string): boolean {
    return !this.closed && this.cut !== null && this.journal === journal && this.key === key
  }

  /** A participant's interest; the last departure before completion cancels unused work. */
  join(): FlightInterest {
    let resolve!: (lease: DerivedImageLease | null) => void
    let settled: DerivedImageLease | null | undefined
    const result = new Promise<DerivedImageLease | null>((done) => {
      resolve = done
    })
    const deliver = (lease: DerivedImageLease | null): void => {
      settled = lease
      resolve(lease)
    }
    this.interests.add(deliver)
    return {
      result,
      leave: () => {
        if (settled !== undefined) {
          settled?.release()
          return
        }
        this.interests.delete(deliver)
        if (this.interests.size === 0 && !this.closed) {
          this.closed = true
          this.sever()
          if (!this.cut) {
            this.end(null)
          }
        }
      }
    }
  }

  /** Synchronous with the leader's capture: reserve source headroom, copy, then publish. */
  capture(): boolean {
    this.releaseSource = this.reads.reserveSource(this.journal, () => this.sever())
    if (!this.releaseSource || this.closed) {
      this.releaseSource?.()
      this.releaseSource = null
      this.end(null)
      return false
    }
    this.cut = this.journal.captureReadCut()
    this.key = this.journal.derivedKey(this.scrollbackRows)
    this.reads.publish(this)
    void this.run(this.cut)
    return true
  }

  private async run(cut: TerminalHistoryReadCut): Promise<TerminalHistoryImage | null> {
    let image: TerminalHistoryImage | null = null
    try {
      image = await this.journal.readImage(cut, {
        scrollbackRows: this.scrollbackRows,
        isCanceled: () => this.controller.signal.aborted
      })
    } finally {
      // I/O and the parser have settled: drop the source, end its charge, then free the slot.
      this.dropSource()
      this.releaseReplay?.()
      this.releaseReplay = null
    }
    this.end(this.controller.signal.aborted ? null : image)
    return image
  }

  /** Pressure or the last departure: close joining, cancel, then drop the source. */
  private sever(): void {
    this.closed = true
    this.controller.abort()
    this.dropSource()
  }

  /** Revokes the pending handle and its parser before the charge for them ends. */
  private dropSource(): void {
    this.cut?.source.revoke()
    this.releaseSource?.()
    this.releaseSource = null
  }

  private end(image: TerminalHistoryImage | null): void {
    this.closed = true
    this.reads.retire(this)
    this.releaseReplay?.()
    this.releaseReplay = null
    const interests = [...this.interests]
    this.interests.clear()
    const entry =
      image && this.key ? this.journal.offerDerived(this.key, this.scrollbackRows, image) : null
    if (entry || !image || interests.length === 0) {
      this.freeLane()
    }
    const shared = entry
      ? null
      : image && sharedUncached(image, interests.length, () => this.freeLane())
    for (const deliver of interests) {
      deliver(entry ? this.reads.images.lease(entry) : (shared?.() ?? null))
    }
  }

  private freeLane(): void {
    this.releaseLane?.()
    this.releaseLane = null
  }
}

/** One untrimmed result outside I: it keeps the cold lane until its last participant settles. */
function sharedUncached(
  image: TerminalHistoryImage,
  participants: number,
  free: () => void
): () => DerivedImageLease {
  let held: TerminalHistoryImage | null = image
  let remaining = participants
  return () => {
    let leased = held
    return {
      get image() {
        return leased
      },
      release: () => {
        if (leased) {
          leased = null
          remaining -= 1
          if (remaining === 0) {
            held = null
            free()
          }
        }
      }
    }
  }
}
