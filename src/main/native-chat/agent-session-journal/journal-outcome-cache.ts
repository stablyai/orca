import type Database from '../../sqlite/sync-database'
import type { JournalReducerState } from './journal-reducer'
import type { JournalOutcome } from './journal-outcome-codec'
import { JOURNAL_OUTCOME_FORMAT, type JournalOutcomeSource } from './journal-outcome-format'
import { JOURNAL_STATE_CODEC_VERSION } from './journal-state-codec'
import { writeJournalProjectionScalars } from './journal-projection-table'

export function journalCacheMatches(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  source: JournalOutcomeSource
): boolean {
  const stamp = db
    .prepare(`SELECT k.epoch, k.generation, k.format, k.through_seq, c.version, c.through_seq AS cached_through
    FROM journal_cache_stamp k JOIN journal_state c ON c.session_id = k.session_id
    AND c.epoch = k.epoch WHERE k.session_id = ?`)
    .get(sessionId)
  return (
    stamp?.epoch === epoch &&
    stamp.generation === source.generation &&
    stamp.format === source.format &&
    stamp.through_seq === source.through &&
    stamp.version === JOURNAL_STATE_CODEC_VERSION &&
    stamp.cached_through === source.through
  )
}

export function writeJournalOutcomeCache(
  db: Database.Database,
  state: JournalReducerState,
  generation: string,
  values: readonly JournalOutcome[],
  stamp = true
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
    const prefix = item
      ? [state.sessionId, state.epoch]
      : [state.sessionId, state.epoch, value.field]
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
  if (!stamp) {
    return
  }
  writeJournalProjectionScalars(db, state)
  db.prepare(`INSERT INTO journal_cache_stamp VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET epoch = excluded.epoch, generation = excluded.generation,
    format = excluded.format, through_seq = excluded.through_seq`).run(
    state.sessionId,
    state.epoch,
    generation,
    JOURNAL_OUTCOME_FORMAT,
    state.lastSequence
  )
}
