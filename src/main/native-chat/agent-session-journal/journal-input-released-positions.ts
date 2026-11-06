import type { JournalInputCard } from './journal-input-lineage'
import type { JournalInputPlace } from './journal-input-order-state'
import type { QueuedMessageRow } from './queued-message-table'
import { JournalInputDomainIndex, type JournalIndexedInputCard } from './journal-input-domain-index'
import {
  JournalInputPlaceIndex,
  mergeInputPlaces,
  type InputPlaceQuery,
  type JournalInputPlaceEntry
} from './journal-input-place-index'

/** Nonselectable native positions outlive the corresponding live card membership. */
export class JournalInputReleasedPositions {
  private readonly domains = new JournalInputDomainIndex()
  private readonly fallbackDomains = new JournalInputDomainIndex()
  private readonly releases = new JournalInputPlaceIndex('introduction')
  private readonly sincePause = new JournalInputPlaceIndex('introduction')
  private count = 0
  private floor = -Infinity

  /** Restored releases and which of them came after the latest pause, for an actual open's export. */
  exportState(): {
    floor: number
    domains: JournalInputDomainIndex
    fallback: JournalInputDomainIndex
    releases: Iterable<JournalInputPlaceEntry>
    sincePause: ReadonlySet<string>
  } {
    const since = new Set<string>()
    for (const entry of this.sincePause.exportEntries()) {
      since.add(entry.id)
    }
    return {
      floor: this.floor,
      domains: this.domains,
      fallback: this.fallbackDomains,
      releases: this.releases.exportEntries(),
      sincePause: since
    }
  }

  pause(cut: number): void {
    this.floor = cut
    this.sincePause.clear()
  }

  delete(prior: JournalIndexedInputCard): void {
    if (prior.releasedAt !== undefined) {
      this.domains.delete(prior.card, { ...prior.source, introduced: prior.releasedAt })
    } else {
      this.fallbackDomains.delete(prior.card, prior.source)
    }
    this.releases.delete(prior.card.messageId)
    this.sincePause.delete(prior.card.messageId)
    this.count--
  }

  add(card: QueuedMessageRow, source: JournalInputCard, releasedAt?: number): void {
    if (releasedAt !== undefined) {
      this.domains.setPosition(card, { ...source, introduced: releasedAt })
    } else {
      this.fallbackDomains.setPosition(card, source)
    }
    if (card.state === 'withdrawn') {
      return
    }
    const coordinate = { epoch: 'introduction', sequence: source.introduced }
    this.releases.setPosition(card.messageId, card.position, 0, coordinate)
    this.sincePause.setPosition(card.messageId, card.position, 0, coordinate)
    this.count++
  }

  query(place: JournalInputPlace): InputPlaceQuery {
    // Released native positions are restamped together on pause, without walking terminal cards.
    let released: InputPlaceQuery = { position: -Infinity }
    if (this.count > 0) {
      if (place.context.basis === 'observed') {
        released = (place.context.cut > this.floor ? this.releases : this.sincePause).query(
          'introduction',
          place.context.cut
        )
      } else if (place.context.cut > this.floor) {
        released = mergeInputPlaces(
          this.domains.query({ ...place.context, cut: this.floor }, place.original),
          this.fallbackDomains.query(place.context, place.original)
        )
      }
    }
    return released
  }
}
