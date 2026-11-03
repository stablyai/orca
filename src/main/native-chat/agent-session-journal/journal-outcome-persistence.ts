import type Database from '../../sqlite/sync-database'
import type { JournalEncodedOutcome } from './journal-persistence-plan'
import type { JournalOutcomeSource } from './journal-outcome-format'
import { JOURNAL_PREFIX_ORDINAL } from './journal-outcome-codec'

export const JOURNAL_NEWEST_OUTCOME_SQL = `SELECT seq, field, entry_key, format, ordinal, value_json,
  deleted FROM journal_outcomes WHERE generation = ? AND (field, entry_key) > (?, ?) AND seq <= ?
  ORDER BY field, entry_key, seq DESC LIMIT 1`

/** Native read-your-writes decides ordinals; the host supplies frozen canonical whole values. */
export function writeJournalEncodedOutcomes(
  db: Database.Database,
  source: Pick<JournalOutcomeSource, 'generation' | 'prefix'>,
  values: readonly JournalEncodedOutcome[]
): void {
  const previous = db.prepare(`SELECT ordinal, deleted FROM journal_outcomes
    WHERE generation = ? AND field = ? AND entry_key = ? ORDER BY seq DESC LIMIT 1`)
  const insert = db.prepare(`INSERT INTO journal_outcomes
    (generation, seq, field, entry_key, format, ordinal, value_json, deleted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const value of values) {
    const kept = previous.get(source.generation, value.field, value.key)
    const appended = `s${String(value.seq).padStart(16, '0')}:${String(value.index).padStart(16, '0')}`
    const ordinal = value.reinsert
      ? appended
      : kept?.deleted === 0 && typeof kept.ordinal === 'string'
        ? kept.ordinal
        : !kept && source.prefix > 0 && value.changed
          ? JOURNAL_PREFIX_ORDINAL
          : appended
    insert.run(
      source.generation,
      value.seq,
      value.field,
      value.key,
      value.format,
      ordinal,
      value.json,
      Number(value.deleted)
    )
  }
}
