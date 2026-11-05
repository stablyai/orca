import type Database from '../../sqlite/sync-database'
import type { SQLInputValue } from 'node:sqlite'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type { JournalReadConnection } from './journal-sql-owner'

export type JournalInputReadSteps<T> = Generator<
  void | SqliteRow[] | Promise<SqliteRow[]>,
  T,
  SqliteRow[]
>
export type JournalInputDatabase = Database.Database | JournalReadConnection
export const JOURNAL_INPUT_EVIDENCE_PAGE = 64

export function finishJournalInputRead<T>(steps: JournalInputReadSteps<T>): T {
  let rows: SqliteRow[] = []
  for (;;) {
    const next = steps.next(rows)
    if (next.done) {
      return next.value
    }
    if (next.value instanceof Promise) {
      throw new Error('async journal read used by a native fixture')
    }
    rows = next.value ?? []
  }
}

export async function finishJournalInputReadAsync<T>(steps: JournalInputReadSteps<T>): Promise<T> {
  let rows: SqliteRow[] = []
  let work = 0
  for (;;) {
    const next = steps.next(rows)
    if (next.done) {
      return next.value
    }
    rows = (await next.value) ?? []
    if (++work === 128) {
      work = 0
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
}

/** First records retain admission/card birth; the indexed subquery also captures last decisions. */
export function firstJournalInputEvidence(db: JournalInputDatabase, field: string) {
  const sql = `SELECT seq,field,entry_key,format,ordinal,value_json,deleted,
    (SELECT seq FROM journal_outcomes WHERE generation=r.generation AND field=r.field
      AND entry_key=r.entry_key AND seq<=? ORDER BY seq DESC LIMIT 1) AS decision_seq
    FROM journal_outcomes AS r WHERE generation=? AND field=? AND entry_key>? AND seq<=?
    AND seq=(SELECT seq FROM journal_outcomes WHERE generation=r.generation AND field=r.field
      AND entry_key=r.entry_key AND seq<=? ORDER BY seq LIMIT 1)
    ORDER BY entry_key LIMIT ${JOURNAL_INPUT_EVIDENCE_PAGE}`
  return (generation: number, after: string, through: number) =>
    db.prepare(sql).all(through, generation, field, after, through, through)
}

/** Each batch has at most two indexed records per admission, on the caller's snapshot. */
export function originalJournalInputItems(
  db: JournalInputDatabase,
  generation: number,
  through: number,
  keys: string[]
): SqliteRow[] | Promise<SqliteRow[]> {
  const parameters: SQLInputValue[] = [generation, ...keys, through, through]
  return db
    .prepare(`SELECT seq,field,entry_key,format,ordinal,value_json,deleted
    FROM journal_outcomes AS r WHERE generation=? AND field IN ('items','itemFences')
    AND entry_key IN (${keys.map(() => '?').join(',')}) AND seq<=?
    AND seq=(SELECT seq FROM journal_outcomes WHERE generation=r.generation AND field=r.field
      AND entry_key=r.entry_key AND seq<=? ORDER BY seq LIMIT 1)`)
    .all(...parameters)
}
