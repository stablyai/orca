export { migrateJournalDomainSchema } from './database/journal-domain-migrations'

/** journal_events.changes_json: identities only; readers load current rows for bodies. */
export type JournalDomainEventChanges = {
  items: { itemId: string; revision: number; sequence: number; sequenceIndex: number }[]
  submissions: string[]
  cards: string[]
  removedItemIds?: string[]
}
