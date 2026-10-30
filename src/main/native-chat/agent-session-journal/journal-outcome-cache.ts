import type Database from '../../sqlite/sync-database'
import type { JournalReducerState } from './journal-reducer'
import type { JournalOutcome } from './journal-outcome-codec'
import type { JournalOutcomeSource } from './journal-outcome-format'
import { JOURNAL_STATE_CODEC_VERSION } from './journal-state-codec'
import { journalStateScalars } from './journal-state-layout'
import { writeJournalProjectionScalars } from './journal-projection-table'

export function journalCacheMatches(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  source: JournalOutcomeSource
): boolean {
  const stamp = db
    .prepare(
      'SELECT epoch, generation, through_seq, version FROM journal_state WHERE session_id = ?'
    )
    .get(sessionId)
  return (
    stamp?.epoch === epoch &&
    stamp.generation === source.generation &&
    stamp.through_seq === source.through &&
    stamp.version === JOURNAL_STATE_CODEC_VERSION
  )
}

export function writeJournalOutcomeCache(
  db: Database.Database,
  state: JournalReducerState,
  generation: number,
  values: readonly JournalOutcome[]
): void {
  writeJournalOutcomeCacheRows(db, state.sessionId, state.epoch, values)
  writeJournalProjectionScalars(db, {
    sessionId: state.sessionId,
    epoch: state.epoch,
    generation,
    through: state.lastSequence,
    stateJson: journalStateScalars(state)
  })
}

/** Upserts whole keyed values in log order, so a later value or deletion wins. */
export function writeJournalOutcomeCacheRows(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  values: readonly JournalOutcome[]
): void {
  for (const value of values) {
    if (value.field === '$') {
      continue
    }
    const item = value.field === 'items'
    const table = item ? 'journal_items' : 'journal_entries'
    const column = item ? 'item_id' : 'entry_key'
    const jsonColumn = item ? 'item_json' : 'entry_json'
    const field = item ? '' : ' AND field = ?'
    const prefix = item ? [sessionId, epoch] : [sessionId, epoch, value.field]
    const key = item ? String(JSON.parse(value.key)) : value.key
    if (value.deleted) {
      db.prepare(`DELETE FROM ${table} WHERE session_id = ? AND epoch = ?${field}
        AND ${column} = ?`).run(...prefix, key)
    } else {
      const columns = item ? '' : ', field'
      const placeholders = item ? '' : ', ?'
      db.prepare(`INSERT INTO ${table} (session_id, epoch${columns}, ${column}, ordinal, ${jsonColumn})
        VALUES (?, ?${placeholders}, ?, ?, ?) ON CONFLICT(session_id, epoch${columns}, ${column})
        DO UPDATE SET ordinal = excluded.ordinal, ${jsonColumn} = excluded.${jsonColumn}`).run(
        ...prefix,
        key,
        value.ordinal,
        value.json
      )
    }
  }
}
