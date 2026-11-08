import type Database from '../../sqlite/sync-database'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import { MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS } from './durable-rows/journal-row-schema'

export type JournalDomainHistoryHeader = {
  itemId: string
  sequence: number
  own: boolean
  subagentGroupKey: string | null
  /** Sent item plus current submission bytes, read without loading either body. */
  bytes: number
}

/** Requires the item alias; octet_length reads a stored length, never the payload. */
export const JOURNAL_DOMAIN_HISTORY_ITEM_BYTES = `COALESCE(item.wire_bytes, octet_length(item.payload_json))
  + COALESCE((SELECT octet_length(attempt.payload_json) FROM journal_submission_attempts attempt
    WHERE attempt.session_id=item.session_id AND attempt.epoch=item.epoch
      AND attempt.item_id=item.item_id AND attempt.current=1), 0)`

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
  const columns = `item_id, sequence, root, subagent_row, subagent_group_key,
    ${JOURNAL_DOMAIN_HISTORY_ITEM_BYTES} AS bytes`
  const order = 'ORDER BY sequence DESC, sequence_index DESC, ordinal DESC'
  const cap = 2 * limit
  const rows = db
    .prepare(
      `SELECT ${columns} FROM journal_items item WHERE ${where} AND sequence<? ${order} LIMIT ?`
    )
    .all(...prefix, end, cap)
  if (rows.length === cap) {
    const boundary = rows.at(-1)!.sequence
    const first = rows.findIndex((row) => row.sequence === boundary)
    // A source lifecycle row creates at most 200 positions; ordinary domain writes create one.
    const group = db
      .prepare(
        `SELECT ${columns} FROM journal_items item WHERE ${where} AND sequence=? ${order} LIMIT ?`
      )
      .all(...prefix, boundary, MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS + 1)
    if (group.length > MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS) {
      throw new Error('journal history exceeds the writer sequence group bound')
    }
    rows.splice(first, rows.length - first, ...group)
  }
  return rows.map((row: SqliteRow) => ({
    itemId: String(row.item_id),
    sequence: Number(row.sequence),
    own: row.root === 1 && row.subagent_row === 0,
    subagentGroupKey: row.subagent_group_key === null ? null : String(row.subagent_group_key),
    bytes: Number(row.bytes)
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

/** Newest whole groups whose stored sizes fit; a lone first group over budget is oversized. */
export function admitJournalDomainHistoryGroups(
  window: readonly JournalDomainHistoryHeader[],
  budgetBytes: number
): { groups: JournalDomainHistoryHeader[][]; oversized: boolean } {
  const groups: JournalDomainHistoryHeader[][] = []
  let total = 0
  for (const group of journalDomainSequenceGroups(window)) {
    const bytes = group.reduce((sum, header) => sum + header.bytes, 0)
    if (groups.length > 0 && total + bytes > budgetBytes) {
      break
    }
    groups.push(group)
    total += bytes
    if (bytes > budgetBytes) {
      return { groups, oversized: true }
    }
  }
  return { groups, oversized: false }
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
