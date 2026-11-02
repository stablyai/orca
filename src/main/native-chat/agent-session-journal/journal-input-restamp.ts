import type { JournalInputPlace } from './journal-input-order-state'
import type { QueuedMessageRow } from './queued-message-table'
import { queryInputContext, type JournalInputCard } from './journal-input-lineage'
import { JournalInputDomainIndex } from './journal-input-domain-index'
import {
  JournalInputPlaceIndex,
  mergeInputPlaces,
  type InputPlaceQuery
} from './journal-input-place-index'

export type JournalIndexedCard = {
  card: QueuedMessageRow
  actionable: boolean
  handoff: boolean
  source?: JournalInputCard
  floored?: true
}

/**
 * A pause rebuild re-introduces every lineage-less card at the current row. Cards the last
 * rebuild placed share that one value here, so a later rebuild visits only cards changed since.
 */
export class JournalInputRestamps {
  private floor = 0
  // Lineage-less cards as the last rebuild placed them, keyed by their queue coordinate.
  private readonly floored = new JournalInputPlaceIndex('')
  // Cards a rebuild would now place differently: indexed without lineage, or released.
  private readonly pending = new Set<string>()
  // Fallback introductions each card holds in the domain index since it was last rebuilt.
  private paths = new Map<string, number[]>()
  // Whether the domain index stands as one built after the last rebuild would.
  private built = false
  private domains: JournalInputDomainIndex | undefined

  restart(floor: number): void {
    this.floor = floor
    this.built = false
  }
  take(): string[] {
    const pending = [...this.pending]
    this.pending.clear()
    return pending
  }
  release(id: string): void {
    this.pending.add(id)
  }
  releaseHistory(): void {
    this.domains = undefined
    this.paths = new Map()
    this.built = false
  }

  /** Places a card as main's rebuild, then its point updates, would; true when floored. */
  place(
    index: JournalInputPlaceIndex,
    entry: JournalIndexedCard,
    lineage: JournalInputCard,
    rebuilding: boolean,
    prior: JournalIndexedCard | undefined
  ): boolean {
    const { card, actionable, handoff } = entry
    const id = card.messageId
    const owned = !entry.source
    // Without a domain index, a fallback stamp at the rebuild's row is the rebuilt entry.
    const floored = !owned && (rebuilding || (!this.domains && lineage.introduced === this.floor))
    if (floored) {
      index.delete(id)
      this.floored.set(card, actionable, handoff)
    } else {
      index.set(card, actionable, handoff, { epoch: 'introduction', sequence: lineage.introduced })
      this.floored.delete(id)
    }
    if (rebuilding) {
      this.unpath(id)
    }
    if (rebuilding || floored) {
      this.pending.delete(id)
    } else if (!owned) {
      this.pending.add(id)
    }
    if (this.domains && !floored) {
      if (prior?.floored && this.built) {
        // A built index already held the rebuilt path; the new one leaves it as main's did.
        this.path(prior, { ...prior.source!, introduced: this.floor })
        this.pending.add(id)
      }
      this.domains.set(card, lineage, actionable, handoff)
      if (!owned && card.state !== 'withdrawn') {
        this.record(id, lineage.introduced)
      }
    }
    return floored
  }

  source(entry: JournalIndexedCard | undefined): JournalInputCard | undefined {
    return entry?.floored ? { ...entry.source, introduced: this.floor } : entry?.source
  }

  head(index: JournalInputPlaceIndex): QueuedMessageRow | undefined {
    return mergeInputPlaces(index.allPlaces(), this.floored.allPlaces()).head
  }

  observed(index: JournalInputPlaceIndex, cut: number): InputPlaceQuery {
    const own = index.query('introduction', cut)
    return this.floor < cut ? mergeInputPlaces(own, this.floored.allPlaces()) : own
  }

  legacy(
    place: JournalInputPlace,
    indexed: ReadonlyMap<string, JournalIndexedCard>,
    lineage: ReadonlyMap<string, JournalInputCard>
  ): InputPlaceQuery {
    const known = (id: string) => {
      const entry = indexed.get(id)
      const source = lineage.get(id) ?? (entry?.floored ? undefined : entry?.source)
      if (entry && source) {
        this.path(entry, source, lineage.has(id))
      }
    }
    if (!this.domains) {
      this.domains = new JournalInputDomainIndex()
      for (const id of indexed.keys()) {
        known(id)
      }
    } else if (!this.built) {
      // A rebuild's domain index holds only each changed card's latest path.
      for (const id of Array.from(this.paths.keys())) {
        this.unpath(id)
        known(id)
      }
    }
    this.built = true
    const { context, original } = place
    const own = this.domains.query(context, original)
    if (this.floor >= context.cut || this.floored.isEmpty()) {
      return own
    }
    return mergeInputPlaces(
      own,
      queryInputContext(
        context,
        original,
        (coordinate) => this.floored.query(coordinate.epoch, coordinate.sequence),
        () => this.floored.allPlaces(),
        mergeInputPlaces
      )
    )
  }

  unpath(id: string): void {
    for (const introduced of this.paths.get(id) ?? []) {
      this.domains?.delete(id, introduced)
    }
    this.paths.delete(id)
  }

  private path(entry: JournalIndexedCard, source: JournalInputCard, owned = false): void {
    this.domains!.set(entry.card, source, entry.actionable, entry.handoff)
    if (!owned) {
      this.record(entry.card.messageId, source.introduced)
    }
  }

  private record(id: string, introduced: number): void {
    this.paths.set(id, [...(this.paths.get(id) ?? []), introduced])
  }
}
