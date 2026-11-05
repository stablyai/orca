import type { TestJournalHostDatabase as JournalHostDatabase } from './journal-host-database-test-support'

/** The text of each keyed record an open decodes: every key's newest live record. */
export function newestEntries(database: JournalHostDatabase) {
  const rows = database.db
    .prepare(
      `SELECT value_json FROM journal_outcomes o WHERE field <> '$' AND deleted = 0 AND seq =
        (SELECT MAX(seq) FROM journal_outcomes WHERE generation = o.generation AND field = o.field
        AND entry_key = o.entry_key)`
    )
    .all()
  return { texts: new Set(rows.map((row) => String(row.value_json))), records: rows.length }
}
/** Distinct keys the chat's records hold, live, deleted and scalar alike. */
export function outcomeKeys(database: JournalHostDatabase): number {
  return Number(
    database.db
      .prepare('SELECT COUNT(*) AS n FROM (SELECT DISTINCT field, entry_key FROM journal_outcomes)')
      .get()?.n
  )
}
