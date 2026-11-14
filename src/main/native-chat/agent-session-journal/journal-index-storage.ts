import type { JournalInputPlaceIndex } from './input-order/journal-input-place-index'
import type { JournalQueuedRowIndex } from './input-order/journal-queued-row-index'
import type { JournalSubmissionIndex } from './input-order/journal-submission-index'
import type { TurnSource } from './input-order/journal-newest-turn-tree'
import type { JournalKeyedMap, JournalKeyedSet } from './journal-keyed-storage'
import type {
  JournalInputOrderFacts,
  JournalInputCardFacts,
  JournalInputObservationFacts,
  JournalInputEvidenceFacts,
  JournalSubmissionLinkFacts
} from './journal-input-facts-storage'
import type { JournalStateQueries } from './journal-state-queries'

// Expose named queries, so a SQL implementation cannot accidentally become a collection scan.
export type JournalInputPlaceStorage = Pick<
  JournalInputPlaceIndex,
  'setPosition' | 'delete' | 'isEmpty' | 'lastId' | 'successorId' | 'idsAfter' | 'allPlaces'
>

/** Live queue rows in (position, message id) order; `set` reports whether membership changed. */
export type JournalQueuedRowStorage = Pick<JournalQueuedRowIndex, 'set' | 'head' | 'values'>

export type JournalSubmissionStorage = Pick<JournalSubmissionIndex, 'keep' | 'list'>

export type JournalTurnSourceStorage = {
  get: (itemId: string) => TurnSource | undefined
  set: (itemId: string, source: TurnSource) => void
  delete: (itemId: string) => void
  latest: () => TurnSource | undefined
  anchor: () => TurnSource | undefined
  winner: () => TurnSource | undefined
}

export type JournalNewestTurnStorage = {
  initializeFromItems: boolean
  sources: JournalTurnSourceStorage
  evidence: JournalKeyedMap<string, string>
  reports: JournalKeyedMap<string, number>
  /** Unknown settlement chronology holds failures until a later Resume. */
  boundary: number
}

export type JournalInputIndexStorage = {
  map: <K, V>(name: string, key?: string | number) => JournalKeyedMap<K, V>
  set: <T>(name: string, key?: string | number) => JournalKeyedSet<T>
  orderFacts: () => JournalInputOrderFacts
  cardFacts: () => JournalInputCardFacts
  observationFacts: () => JournalInputObservationFacts
  evidenceFacts: () => JournalInputEvidenceFacts
  linkFacts: () => JournalSubmissionLinkFacts
  place: (name: string, key?: string | number) => JournalInputPlaceStorage
  queuedRows: (name: string) => JournalQueuedRowStorage
  submissions: (name: string) => JournalSubmissionStorage
  newestTurn: () => JournalNewestTurnStorage
}

export type JournalIndexStorageFactory = JournalInputIndexStorage & {
  stateQueries: () => JournalStateQueries
}
