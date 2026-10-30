import type Database from '../../sqlite/sync-database'
import type { JournalReducerState } from './journal-reducer'
import {
  journalEntryJson,
  journalStateCollections,
  journalStateScalars
} from './journal-state-layout'
import { clearJournalSavedState, writeJournalProjectionScalars } from './journal-projection-table'
import { readJournalSavedView } from './journal-saved-state'

/** The decoded saved view, or null when it is absent or unreadable. */
export function readJournalSavedState(
  db: Database.Database,
  sessionId: string,
  epoch: string
): JournalReducerState | null {
  const view = readJournalSavedView(db, sessionId, epoch)
  return typeof view === 'string' ? null : view
}

/** An unstamped (generation 0) view: only an outcome generation's stamp makes an open read it. */
export function publishJournalProjection(db: Database.Database, state: JournalReducerState): void {
  clearJournalSavedState(db, state.sessionId)
  const insertItem = db.prepare(`INSERT INTO journal_items
    (session_id, epoch, item_id, ordinal, item_json) VALUES (?, ?, ?, ?, ?)`)
  let ordinal = 0
  for (const [key, item] of state.items) {
    insertItem.run(
      state.sessionId,
      state.epoch,
      key,
      String(ordinal++).padStart(16, '0'),
      JSON.stringify(item)
    )
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
        String(ordinal++).padStart(16, '0'),
        journalEntryJson(key, value)
      )
    }
  }
  writeJournalProjectionScalars(db, {
    sessionId: state.sessionId,
    epoch: state.epoch,
    generation: 0,
    through: state.lastSequence,
    stateJson: journalStateScalars(state)
  })
}
