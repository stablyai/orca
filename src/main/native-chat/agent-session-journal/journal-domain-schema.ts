export { migrateJournalDomainSchema } from './database/journal-domain-migrations'

/** journal_events.changes_json: identities only; readers load current rows for bodies. */
export type JournalDomainEventChanges = {
  items: { itemId: string; revision: number; sequence: number; sequenceIndex: number }[]
  submissions: string[]
  cards: string[]
  removedItemIds?: string[]
  /** Submissions whose only change is their writtenAt stamp: restated alone, without their message or the queue. */
  writtenSubmissions?: string[]
}
