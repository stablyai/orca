import type Database from '../../sqlite/sync-database'
import type { JournalReducerState } from './journal-reducer'
import { journalEntryJson, journalStateCollections } from './journal-state-layout'
import { clearJournalSavedState, writeJournalProjectionScalars } from './journal-projection-table'

export function publishJournalProjection(db: Database.Database, state: JournalReducerState): void {
  clearJournalSavedState(db, state.sessionId)
  const insertItem = db.prepare(`INSERT INTO journal_items
    (session_id, epoch, item_id, ordinal, item_json) VALUES (?, ?, ?, ?, ?)`)
  let ordinal = 0
  for (const [key, item] of state.items) {
    insertItem.run(state.sessionId, state.epoch, key, ordinal++, JSON.stringify(item))
  }
  const insertEntry = db.prepare(`INSERT INTO journal_entries
    (session_id, epoch, field, entry_key, ordinal, entry_json) VALUES (?, ?, ?, ?, ?, ?)`)
  for (const { path, entries } of journalStateCollections(state)) {
    if (path === 'items') {
      continue
    }
    ordinal = 0
    for (const [key, value] of entries) {
      insertEntry.run(
        state.sessionId,
        state.epoch,
        path,
        JSON.stringify(key),
        ordinal++,
        journalEntryJson(key, value)
      )
    }
  }
  writeJournalProjectionScalars(db, state)
}
