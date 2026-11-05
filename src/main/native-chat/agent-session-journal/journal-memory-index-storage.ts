import type { JournalIndexStorageFactory } from './journal-index-storage'
import { JournalInputPlaceIndex } from './journal-input-place-index'
import { JournalInputDomainIndex } from './journal-input-domain-index'
import { JournalInputReleasedPositions } from './journal-input-released-positions'
import { JournalInputCandidates } from './journal-input-candidates'
import { JournalSubmissionIndex } from './journal-submission-index'
import { MemoryJournalTurnSources } from './journal-memory-turn-sources'

export const memoryJournalIndexStorage: JournalIndexStorageFactory = {
  place: () => new JournalInputPlaceIndex(''),
  domain: () => new JournalInputDomainIndex(),
  released: () => new JournalInputReleasedPositions(),
  candidates: () => new JournalInputCandidates(),
  submissions: () => new JournalSubmissionIndex(),
  newestTurn: () => ({
    sources: new MemoryJournalTurnSources(),
    evidence: new Map(),
    reports: new Map(),
    boundary: 0
  })
}
