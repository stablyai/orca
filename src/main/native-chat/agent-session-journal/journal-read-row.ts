import type Database from '../../sqlite/sync-database'
import type { JournalRow } from './journal-row-schema'
import type { JournalOutcomeSource } from './journal-outcome-format'

type JournalOutcomeKeys = { itemIds: string[]; submissionIds: string[]; queueCardIds: string[] }

/** In-process change index only; the public wire still contains items and submissions. Each array
 * names the sequence's touched keys; `deleted` repeats the ones it removed. */
export type JournalOutcomeReadRow = JournalOutcomeKeys & {
  kind: 'outcome'
  epoch: string
  seq: number
  deleted: JournalOutcomeKeys
}
export type JournalReadRow = JournalRow | JournalOutcomeReadRow

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
  const touched = db.prepare(`SELECT field, entry_key, deleted FROM journal_outcomes
    WHERE generation = ? AND seq = ? AND field IN ('items', 'submissions', 'queue.cards')
    ORDER BY field, entry_key`)
  return groups.map(({ seq }) => {
    if (typeof seq !== 'number') {
      throw new Error('invalid journal outcome group')
    }
    const keys = emptyOutcomeKeys()
    const deleted = emptyOutcomeKeys()
    for (const entry of touched.iterate(source.generation, seq)) {
      if (typeof entry.entry_key !== 'string') {
        throw new Error('invalid journal outcome key')
      }
      const key: unknown = JSON.parse(entry.entry_key)
      if (typeof key !== 'string') {
        throw new Error('invalid journal public outcome key')
      }
      const field =
        entry.field === 'items'
          ? 'itemIds'
          : entry.field === 'submissions'
            ? 'submissionIds'
            : 'queueCardIds'
      keys[field].push(key)
      if (entry.deleted === 1) {
        deleted[field].push(key)
      }
    }
    return { kind: 'outcome', epoch, seq, ...keys, deleted }
  })
}

function emptyOutcomeKeys(): JournalOutcomeKeys {
  return { itemIds: [], submissionIds: [], queueCardIds: [] }
}
