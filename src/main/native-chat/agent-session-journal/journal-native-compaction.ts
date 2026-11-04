import type Database from '../../sqlite/sync-database'
import type {
  JournalCompactionSource as Active,
  JournalCompactionProgress as Progress
} from './journal-maintenance-unit'
import {
  JOURNAL_OUTCOME_FORMAT_1,
  OUTCOME_FORMAT_1_COLLECTIONS,
  outcomeFormat1StoredScalars
} from './journal-outcome-format-1'
import { JOURNAL_OUTCOME_FORMAT_2, isNativeOutcomeField } from './journal-outcome-format-2'

const PAGE_SIZE = 32
const fields = new Set<string>(OUTCOME_FORMAT_1_COLLECTIONS)
const scalars = new Set(
  Object.keys(outcomeFormat1StoredScalars.shape).map((key) => JSON.stringify(key))
)
const ordinary = (field: string, key: string): boolean =>
  field === '$' ? scalars.has(key) : fields.has(field)
const formats = new Map<number, (field: string, key: string) => boolean>([
  [JOURNAL_OUTCOME_FORMAT_1, ordinary],
  [JOURNAL_OUTCOME_FORMAT_2, (field, key) => ordinary(field, key) || isNativeOutcomeField(field)]
])
export function admitsJournalCompactionFormat(format: number): boolean {
  return formats.has(format)
}

/** The existing bounded compaction body runs only on the native writer. */
export function compactJournalOutcomePage(db: Database.Database, active: Active): Progress {
  const next: Progress = { more: true, generation: active.generation, active: null }
  // A rewind can retire this generation during a rest; the existing retired-epoch sweep owns it.
  const source = db
    .prepare(`SELECT generation, format FROM journal_outcome_epochs
      WHERE session_id = ? AND epoch = ?`)
    .get(active.sessionId, active.epoch)
  if (
    source?.generation !== active.generation ||
    typeof source.format !== 'number' ||
    !formats.has(source.format)
  ) {
    return next
  }
  const rows = db
    .prepare(`SELECT seq, field, entry_key, format, deleted
      FROM journal_outcomes WHERE generation = ? AND (seq, field, entry_key) > (?, ?, ?)
      AND seq <= ? ORDER BY seq, field, entry_key LIMIT ${PAGE_SIZE}`)
    .all(active.generation, active.after.seq, active.after.field, active.after.key, active.through)
  const first = db.prepare(`SELECT seq FROM journal_outcomes
      WHERE generation = ? AND field = ? AND entry_key = ? ORDER BY seq LIMIT 1`)
  const latest = db.prepare(`SELECT seq FROM journal_outcomes
      WHERE generation = ? AND field = ? AND entry_key = ? ORDER BY seq DESC LIMIT 1`)
  const remove = db.prepare(`DELETE FROM journal_outcomes
      WHERE generation = ? AND seq = ? AND field = ? AND entry_key = ? AND format = ?`)
  let after = active.after
  for (const row of rows) {
    const admits = typeof row.format === 'number' ? formats.get(row.format) : undefined
    if (
      !admits ||
      typeof row.seq !== 'number' ||
      typeof row.field !== 'string' ||
      typeof row.entry_key !== 'string' ||
      !admits(row.field, row.entry_key)
    ) {
      // Never inspect or delete past a record whose contract this build does not know.
      return next
    }
    after = { seq: row.seq, field: row.field, key: row.entry_key }
    if (row.deleted !== 0 || row.field === 'tombstones' || row.field === 'removedTurnIds') {
      continue
    }
    const key = [active.generation, row.field, row.entry_key]
    // Declared formats store whole values per key; superseded middle values are redundant.
    // Changing that replacement meaning requires a format bump.
    if (row.seq !== first.get(...key)?.seq && row.seq !== latest.get(...key)?.seq) {
      remove.run(active.generation, row.seq, row.field, row.entry_key, row.format)
    }
  }
  return rows.length < PAGE_SIZE
    ? { ...next, done: [active.generation, active.through] }
    : { ...next, active: { ...active, after } }
}
