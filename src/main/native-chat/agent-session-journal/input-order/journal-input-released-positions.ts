import type { JournalInputCard } from './journal-input-lineage'
import type { JournalInputPlace } from './journal-input-order-state'
import type { QueuedMessageRow } from '../queued-messages/queued-message-table'
import type { JournalIndexedInputCard } from './legacy-queue-card-index'
import {
  JournalInputPlaceIndex,
  type InputPlaceQuery,
  type JournalInputPlaceEntry
} from './journal-input-place-index'

/** Nonselectable native positions outlive the corresponding live card membership. */
export class JournalInputReleasedPositions {
  private readonly releases = new JournalInputPlaceIndex('introduction')
  private readonly sincePause = new JournalInputPlaceIndex('introduction')
  private count = 0
  private floor = -Infinity

  /** Restored releases and which of them came after the latest pause, for an actual open's export. */
  exportState(): {
    floor: number
    releases: Iterable<JournalInputPlaceEntry>
    sincePause: ReadonlySet<string>
  } {
    const since = new Set<string>()
    for (const entry of this.sincePause.exportEntries()) {
      since.add(entry.id)
    }
    return {
      floor: this.floor,
      releases: this.releases.exportEntries(),
      sincePause: since
    }
  }

  pause(cut: number): void {
    this.floor = cut
    this.sincePause.clear()
  }

  delete(prior: JournalIndexedInputCard): void {
    this.releases.delete(prior.card.messageId)
    this.sincePause.delete(prior.card.messageId)
    this.count--
  }

  add(card: QueuedMessageRow, source: JournalInputCard): void {
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
      released = (place.context.cut > this.floor ? this.releases : this.sincePause).query(
        'introduction',
        place.context.cut
      )
    }
    return released
  }
}
