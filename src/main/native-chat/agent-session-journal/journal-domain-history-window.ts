import type Database from '../../sqlite/sync-database'
import type { SqliteRow } from '../../sqlite/sqlite-statement'

export type JournalDomainHistoryHeader = {
  itemId: string
  sequence: number
  own: boolean
  subagentGroupKey: string | null
}

/** Chooses the page's candidate identities before any body or submission is decoded. */
export function selectJournalDomainHistoryWindow(
  db: Database.Database,
  where: string,
  prefix: readonly [string, string],
  end: number,
  limit: number
): JournalDomainHistoryHeader[] {
  return historyWindow(selectJournalDomainHistoryHeaders(db, where, prefix, end, limit), limit)
}

/** Newest-first keyset over every scoped row: the existing 2×limit reach also caps sparse-root chats.
 *  An epoch+sequence cursor cannot split a sequence, so the boundary sequence is completed whole. */
function selectJournalDomainHistoryHeaders(
  db: Database.Database,
  where: string,
  prefix: readonly [string, string],
  end: number,
  limit: number
): JournalDomainHistoryHeader[] {
  const columns = 'item_id, sequence, root, subagent_row, subagent_group_key'
  const order = 'ORDER BY sequence DESC, sequence_index DESC, ordinal DESC'
  const cap = 2 * limit
  const rows = db
    .prepare(`SELECT ${columns} FROM journal_items WHERE ${where} AND sequence<? ${order} LIMIT ?`)
    .all(...prefix, end, cap)
  if (rows.length === cap) {
    const boundary = rows.at(-1)!.sequence
    const first = rows.findIndex((row) => row.sequence === boundary)
    rows.splice(
      first,
      rows.length - first,
      ...db
        .prepare(`SELECT ${columns} FROM journal_items WHERE ${where} AND sequence=? ${order}`)
        .all(...prefix, boundary)
    )
  }
  return rows.map((row: SqliteRow) => ({
    itemId: String(row.item_id),
    sequence: Number(row.sequence),
    own: row.root === 1 && row.subagent_row === 0,
    subagentGroupKey: row.subagent_group_key === null ? null : String(row.subagent_group_key)
  }))
}

/** Window by own-agent rows, retaining interleaved subagent work and its whole groups within the candidates. */
function historyWindow(
  headers: readonly JournalDomainHistoryHeader[],
  limit: number
): JournalDomainHistoryHeader[] {
  let own = 0
  let start: number | undefined
  for (const group of journalDomainSequenceGroups(headers)) {
    const count = group.filter((header) => header.own).length
    if (count === 0) {
      continue
    }
    if (own > 0 && own + count > limit) {
      const firstOf = new Map<string, number>()
      for (const header of headers) {
        if (header.subagentGroupKey !== null) {
          firstOf.set(header.subagentGroupKey, header.sequence)
        }
      }
      let whole = start!
      for (const header of headers) {
        if (header.sequence < whole) {
          break
        }
        if (header.subagentGroupKey !== null) {
          whole = Math.min(whole, firstOf.get(header.subagentGroupKey)!)
        }
      }
      return headers.filter((header) => header.sequence >= whole)
    }
    own += count
    start = group[0]!.sequence
  }
  return [...headers]
}

/** Newest group first; each group keeps render order. */
export function* journalDomainSequenceGroups<T extends { sequence: number }>(
  rows: readonly T[]
): Generator<T[]> {
  let group: T[] = []
  for (const row of rows) {
    if (group.length > 0 && row.sequence !== group[0]!.sequence) {
      yield group.toReversed()
      group = []
    }
    group.push(row)
  }
  if (group.length > 0) {
    yield group.toReversed()
  }
}
