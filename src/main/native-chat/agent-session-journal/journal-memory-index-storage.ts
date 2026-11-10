import type { JournalIndexStorageFactory } from './journal-index-storage'
import { memoryJournalInputIndexStorage } from './journal-memory-input-index-storage'
import { memoryJournalStateQueries } from './journal-memory-state-queries'

export const memoryJournalIndexStorage: JournalIndexStorageFactory = {
  ...memoryJournalInputIndexStorage,
  stateQueries: () => memoryJournalStateQueries
}
