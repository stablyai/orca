import type { JournalInputIndexStorage } from './journal-index-storage'
import { JournalInputPlaceIndex } from './input-order/journal-input-place-index'
import { JournalQueuedRowIndex } from './input-order/journal-queued-row-index'
import { JournalSubmissionIndex } from './input-order/journal-submission-index'
import { MemoryJournalTurnSources } from './journal-memory-turn-sources'
import {
  memoryJournalInputOrderFacts,
  memoryJournalInputCardFacts,
  memoryJournalInputObservationFacts,
  memoryJournalInputEvidenceFacts,
  memoryJournalSubmissionLinkFacts
} from './journal-memory-input-facts'

export const memoryJournalInputIndexStorage: JournalInputIndexStorage = {
  map: () => new Map(),
  set: () => new Set(),
  orderFacts: memoryJournalInputOrderFacts,
  cardFacts: memoryJournalInputCardFacts,
  observationFacts: memoryJournalInputObservationFacts,
  evidenceFacts: memoryJournalInputEvidenceFacts,
  linkFacts: memoryJournalSubmissionLinkFacts,
  place: () => new JournalInputPlaceIndex(''),
  queuedRows: () => new JournalQueuedRowIndex(),
  submissions: () => new JournalSubmissionIndex(),
  newestTurn: () => ({
    initializeFromItems: true,
    sources: new MemoryJournalTurnSources(),
    evidence: new Map(),
    reports: new Map(),
    boundary: 0
  })
}
