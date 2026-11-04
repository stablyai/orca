import type { JournalReadConnection } from './journal-sql-owner'
import type Database from '../../sqlite/sync-database'
import type { JournalRow } from './journal-row-schema'
import type { JournalOutcomeSource } from './journal-outcome-format'
import { decodingOutcome, JournalOutcomeDecodeError } from './journal-outcome-codec'

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
      throw new JournalOutcomeDecodeError('invalid journal outcome group')
    }
    const itemIds: string[] = []
    const submissionIds: string[] = []
    for (const entry of touched.iterate(source.generation, seq)) {
      const key = publicOutcomeKey(entry.entry_key)
      if (entry.field === 'items') {
        itemIds.push(key)
      } else {
        submissionIds.push(key)
      }
    }
    return { kind: 'outcome', epoch, seq, itemIds, submissionIds }
  })
}

function publicOutcomeKey(stored: unknown): string {
  return decodingOutcome(() => {
    const key: unknown = typeof stored === 'string' ? JSON.parse(stored) : undefined
    if (typeof key !== 'string') {
      throw new Error('invalid journal public outcome key')
    }
    return key
  })
}

export async function readJournalOutcomeGroupsAsync(
  read: JournalReadConnection,
  epoch: string,
  source: JournalOutcomeSource,
  after: number,
  limit?: number
): Promise<JournalOutcomeReadRow[]> {
  const groups: JournalOutcomeReadRow[] = []
  for await (const page of read.pages(
    `SELECT DISTINCT seq FROM journal_outcomes WHERE generation = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?`,
    [source.generation, after, source.through, limit ?? -1]
  )) {
    for (const { seq } of page) {
      if (typeof seq !== 'number') {
        throw new JournalOutcomeDecodeError('invalid journal outcome group')
      }
      const group: JournalOutcomeReadRow = {
        kind: 'outcome',
        epoch,
        seq,
        itemIds: [],
        submissionIds: []
      }
      for await (const entries of read.pages(
        `SELECT field, entry_key FROM journal_outcomes WHERE generation = ? AND seq = ? AND field IN ('items', 'submissions') ORDER BY field, entry_key`,
        [source.generation, seq]
      )) {
        for (const entry of entries) {
          const key = publicOutcomeKey(entry.entry_key)
          if (entry.field === 'items') {
            group.itemIds.push(key)
          } else {
            group.submissionIds.push(key)
          }
        }
      }
      groups.push(group)
    }
  }
  return groups
}
