import type { JournalInputPlaceIndex } from './journal-input-place-index'
import type { JournalInputDomainIndex } from './journal-input-domain-index'
import type { JournalInputReleasedPositions } from './journal-input-released-positions'
import type { JournalInputCandidates } from './journal-input-candidates'
import type { JournalSubmissionIndex } from './journal-submission-index'
import type { TurnSource } from './journal-newest-turn-tree'
import type { JournalKeyedMap } from './journal-keyed-storage'

// Expose named queries, so a SQL implementation cannot accidentally become a collection scan.
export type JournalInputPlaceStorage = Pick<
  JournalInputPlaceIndex,
  | 'set'
  | 'setPosition'
  | 'delete'
  | 'clear'
  | 'isEmpty'
  | 'query'
  | 'lastId'
  | 'successorId'
  | 'idsAfter'
  | 'firstPosition'
  | 'allPlaces'
>

export type JournalInputDomainStorage = Pick<
  JournalInputDomainIndex,
  'set' | 'setPosition' | 'delete' | 'clear' | 'query'
>

export type JournalInputReleasedStorage = Pick<
  JournalInputReleasedPositions,
  'pause' | 'delete' | 'add' | 'query'
>

export type JournalInputCandidateStorage = Pick<
  JournalInputCandidates,
  'set' | 'clear' | 'hasMail' | 'after' | 'pastHead'
>

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
  sources: JournalTurnSourceStorage
  evidence: JournalKeyedMap<string, string>
  reports: JournalKeyedMap<string, number>
  /** Unknown settlement chronology holds failures until a later Resume. */
  boundary: number
}

export type JournalIndexStorageFactory = {
  place: (name: string, key?: string | number) => JournalInputPlaceStorage
  domain: (name: string) => JournalInputDomainStorage
  released: (name: string) => JournalInputReleasedStorage
  candidates: (name: string) => JournalInputCandidateStorage
  submissions: (name: string) => JournalSubmissionStorage
  newestTurn: () => JournalNewestTurnStorage
}
