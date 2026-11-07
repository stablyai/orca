import type { JournalIndexStorageFactory } from './journal-index-storage'
import { JournalInputPlaceIndex } from './input-order/journal-input-place-index'
import { JournalInputDomainIndex } from './input-order/journal-input-domain-index'
import { JournalInputReleasedPositions } from './input-order/journal-input-released-positions'
import { JournalInputCandidates } from './input-order/journal-input-candidates'
import { JournalSubmissionIndex } from './input-order/journal-submission-index'
import { MemoryJournalTurnSources } from './journal-memory-turn-sources'
import { memoryJournalStateQueries } from './journal-memory-state-queries'
import {
  memoryJournalInputOrderFacts,
  memoryJournalInputCardFacts,
  memoryJournalInputObservationFacts,
  memoryJournalInputEvidenceFacts,
  memoryJournalSubmissionLinkFacts,
  memoryJournalInputLineageFacts
} from './journal-memory-input-facts'

export const memoryJournalIndexStorage: JournalIndexStorageFactory = {
  stateQueries: () => memoryJournalStateQueries,
  map: () => new Map(),
  set: () => new Set(),
  orderFacts: memoryJournalInputOrderFacts,
  cardFacts: memoryJournalInputCardFacts,
  observationFacts: memoryJournalInputObservationFacts,
  evidenceFacts: memoryJournalInputEvidenceFacts,
  linkFacts: memoryJournalSubmissionLinkFacts,
  lineageFacts: memoryJournalInputLineageFacts,
  place: () => new JournalInputPlaceIndex(''),
  domain: () => new JournalInputDomainIndex(),
  released: () => new JournalInputReleasedPositions(),
  candidates: () => new JournalInputCandidates(),
  submissions: () => new JournalSubmissionIndex(),
  newestTurn: () => ({
    initializeFromItems: true,
    sources: new MemoryJournalTurnSources(),
    evidence: new Map(),
    reports: new Map(),
    boundary: 0
  })
}
