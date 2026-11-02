import type Database from '../../sqlite/sync-database'
import { parseJournalRow, type JournalRow } from './journal-row-schema'
import { journalOutcomeSource, type JournalOutcomeSource } from './journal-outcome-format'
import { readJournalRowsAfter } from './journal-row-table'

/** In-process change index only; the public wire still contains items and submissions. */
export type JournalOutcomeReadRow = {
  kind: 'outcome'
  epoch: string
  seq: number
  itemIds: string[]
  submissionIds: string[]
}
export type JournalReadRow = JournalRow | JournalOutcomeReadRow
/** `through` is the highest sequence the read covered, which may store no record of its own. */
export type JournalRowsRead = { rows: JournalReadRow[]; through: number }

/** LIMIT counts logical sequences, never the independently compactable physical contributions. */
export function readJournalOutcomeGroups(
  db: Database.Database,
  epoch: string,
  source: JournalOutcomeSource,
  after: number,
  limit?: number
): JournalOutcomeReadRow[] {
  const groups = db
    .prepare(`SELECT DISTINCT seq FROM journal_outcomes
    WHERE generation = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?`)
    .all(source.generation, after, source.through, limit ?? -1)
  const touched = db.prepare(`SELECT field, entry_key FROM journal_outcomes
    WHERE generation = ? AND seq = ? AND field IN ('items', 'submissions') ORDER BY field, entry_key`)
  return groups.map(({ seq }) => {
    if (typeof seq !== 'number') {
      throw new Error('invalid journal outcome group')
    }
    const itemIds: string[] = []
    const submissionIds: string[] = []
    for (const entry of touched.iterate(source.generation, seq)) {
      if (typeof entry.entry_key !== 'string') {
        throw new Error('invalid journal outcome key')
      }
      const key: unknown = JSON.parse(entry.entry_key)
      if (typeof key !== 'string') {
        throw new Error('invalid journal public outcome key')
      }
      if (entry.field === 'items') {
        itemIds.push(key)
      } else {
        submissionIds.push(key)
      }
    }
    return { kind: 'outcome', epoch, seq, itemIds, submissionIds }
  })
}

export function journalRowsAfterReader(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  limit?: number
): (afterSequence: number) => JournalRowsRead {
  return (afterSequence) => readJournalRowsAfterCursor(db, sessionId, epoch, afterSequence, limit)
}

/** Stop replay at the first unreadable row; never serve a partial tail beyond it. A chat with an
 * input prefix pages its rows, then its outcome groups, each sequence exactly once. */
export function readJournalRowsAfterCursor(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  afterSequence: number,
  limit?: number
): JournalRowsRead {
  const source = journalOutcomeSource(db, sessionId, epoch)
  const prefix = source ? source.prefix : Number.POSITIVE_INFINITY
  const rows: JournalReadRow[] = []
  // A read that stops early covers only the rows it returned.
  const stopped = (): JournalRowsRead => ({ rows, through: rows.at(-1)?.seq ?? afterSequence })
  if (afterSequence < prefix) {
    for (const stored of readJournalRowsAfter(db, sessionId, epoch, afterSequence, limit)) {
      const parsed =
        stored.seq <= prefix ? parseJournalRow(stored.rowJson, source?.marker !== 5) : null
      if (!parsed?.ok) {
        // An unreadable prefix row ends the page; outcome groups never skip past it.
        return parsed ? stopped() : groupsAfter(prefix)
      }
      rows.push(parsed.row)
    }
    if (!source || (limit !== undefined && rows.length >= limit)) {
      return stopped()
    }
  }
  return groupsAfter(Math.max(afterSequence, prefix))

  function groupsAfter(after: number): JournalRowsRead {
    if (!source) {
      return stopped()
    }
    const remaining = limit === undefined ? undefined : limit - rows.length
    const groups = readJournalOutcomeGroups(db, epoch, source, after, remaining)
    // Append one by one: spreading an unlimited read into push's arguments overflows the stack.
    for (const group of groups) {
      rows.push(group)
    }
    // A write whose fold changed nothing stores no record, so no group names its sequence; a read
    // that returned every group still covers the epoch through its newest write.
    return remaining === undefined || groups.length < remaining
      ? { rows, through: source.through }
      : stopped()
  }
}
