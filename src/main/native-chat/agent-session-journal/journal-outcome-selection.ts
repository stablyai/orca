import type Database from '../../sqlite/sync-database'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type { JournalOutcomeSource } from './journal-outcome-format'

// The recursive step seeks past a complete key, so even long superseded streams are skipped.
export const JOURNAL_RECURSIVE_NEWEST_OUTCOME_SQL = `WITH RECURSIVE newest AS (
  SELECT * FROM (SELECT seq,field,entry_key,format,ordinal,value_json,deleted
    FROM journal_outcomes WHERE generation=?1 AND (field,entry_key)>('','') AND seq<=?2
    ORDER BY field,entry_key,seq DESC LIMIT 1)
  UNION ALL
  SELECT next.seq,next.field,next.entry_key,next.format,next.ordinal,next.value_json,next.deleted
  FROM newest AS prior CROSS JOIN journal_outcomes AS next
    ON next.generation=?1 AND (next.field,next.entry_key,next.seq)=(
      SELECT * FROM (SELECT field,entry_key,seq FROM journal_outcomes
        WHERE generation=?1 AND field=prior.field AND entry_key>prior.entry_key AND seq<=?2
        ORDER BY entry_key,seq DESC LIMIT 1)
      UNION ALL
      SELECT * FROM (SELECT field,entry_key,seq FROM journal_outcomes
        WHERE generation=?1 AND field>prior.field AND seq<=?2
        ORDER BY field,entry_key,seq DESC LIMIT 1)
      LIMIT 1)
) SELECT * FROM newest`

/** One native iterator over the same selected records as the per-key seek oracle. */
export function iterateSelectedJournalOutcomes(
  db: Database.Database,
  source: JournalOutcomeSource
): IterableIterator<SqliteRow> {
  return db.prepare(JOURNAL_RECURSIVE_NEWEST_OUTCOME_SQL).iterate(source.generation, source.through)
}
