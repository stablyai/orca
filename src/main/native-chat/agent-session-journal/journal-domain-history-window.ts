import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalReadRow } from './replay/journal-read-row'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type Database from '../../sqlite/sync-database'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import { MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS } from './durable-rows/journal-row-schema'
import { AGENT_SESSION_ITEM_WIRE_VERSION } from '../agent-session-wire/publication/history/agent-session-item-presentation-contract'
import type { HistoryItemForm } from '../agent-session-wire/publication/history/agent-session-history-page-bounds'
import { readJournalDomainClientForms } from './journal-domain-item-presentation'
import { readJournalDomainStopStates } from './journal-domain-item-display'

export type JournalDomainHistoryHeader = {
  itemId: string
  sequence: number
  sequenceIndex: number
  ordinal: number
  own: boolean
  subagentGroupKey: string | null
  /** Stored size without body reads; retained sources still need exact reader-form admission. */
  bytes: number | null
  submissionBytes?: number
}

/** Requires the item alias; octet_length reads a stored length, never the payload. */
export const JOURNAL_DOMAIN_HISTORY_SUBMISSION_BYTES = `COALESCE((SELECT octet_length(attempt.payload_json) FROM journal_submission_attempts attempt
    WHERE attempt.session_id=item.session_id AND attempt.epoch=item.epoch
      AND attempt.item_id=item.item_id AND attempt.current=1), 0)`
export const JOURNAL_DOMAIN_HISTORY_ITEM_BYTES = `CASE WHEN item.wire_version=${AGENT_SESSION_ITEM_WIRE_VERSION}
  THEN COALESCE(item.wire_bytes, octet_length(item.payload_json)) END
  + ${JOURNAL_DOMAIN_HISTORY_SUBMISSION_BYTES}`

/** Chooses the page's candidate identities before any body or submission is decoded. */
export function selectJournalDomainHistoryWindow(
  db: Database.Database,
  where: string,
  prefix: readonly [string, string],
  end: number,
  limit: number,
  sources: readonly JournalDomainHistoryHeader[] = []
): JournalDomainHistoryHeader[] {
  const headers = [
    ...selectJournalDomainHistoryHeaders(db, where, prefix, end, limit),
    ...sources.filter((source) => source.sequence < end)
  ].sort(
    (a, b) => b.sequence - a.sequence || b.sequenceIndex - a.sequenceIndex || b.ordinal - a.ordinal
  )
  const boundary = headers[2 * limit - 1]?.sequence
  return historyWindow(
    boundary === undefined ? headers : headers.filter((header) => header.sequence >= boundary),
    limit
  )
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
  const columns = `item_id, sequence, sequence_index, ordinal, root, subagent_row, subagent_group_key,
    CASE WHEN item.wire_version=${AGENT_SESSION_ITEM_WIRE_VERSION} THEN 0
      ELSE ${JOURNAL_DOMAIN_HISTORY_SUBMISSION_BYTES} END AS submission_bytes,
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
    sequenceIndex: Number(row.sequence_index),
    ordinal: Number(row.ordinal),
    own: row.root === 1 && row.subagent_row === 0,
    subagentGroupKey: row.subagent_group_key === null ? null : String(row.subagent_group_key),
    bytes: row.bytes === null ? null : Number(row.bytes),
    submissionBytes: Number(row.submission_bytes)
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
  budgetBytes: number,
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  forms: Map<string, HistoryItemForm>
): { groups: JournalDomainHistoryHeader[][]; oversized: boolean } {
  const groups: JournalDomainHistoryHeader[][] = []
  let total = 0
  const states = readJournalDomainStopStates(
    db,
    target,
    window.filter((header) => header.bytes === null).map((header) => header.itemId)
  )
  for (const group of journalDomainSequenceGroups(window)) {
    const stale = group.filter((header) => header.bytes === null)
    const current = readJournalDomainClientForms(
      db,
      target,
      stale.map((header) => header.itemId),
      new Map(),
      states
    )
    const bytes = group.reduce(
      (sum, header) =>
        sum + (header.bytes ?? current.get(header.itemId)!.bytes + (header.submissionBytes ?? 0)),
      0
    )
    if (groups.length > 0 && total + bytes > budgetBytes) {
      break
    }
    for (const [id, form] of current) {
      forms.set(id, form)
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

/** An oversized group's placeholders keep each row's identity and placement, never its body. */
export function readJournalDomainHistoryEnvelope(
  db: Database.Database,
  prefix: readonly [string, string],
  itemId: string
): AgentJournalRenderItem {
  const row = db
    .prepare(`SELECT placement_json AS envelope,revision,sequence,sequence_index FROM journal_items
      WHERE session_id=? AND epoch=? AND item_id=?`)
    .get(...prefix, itemId)!
  // The placeholder replaces the omitted body.
  return {
    ...JSON.parse(String(row.envelope)),
    revision: Number(row.revision),
    sequence: Number(row.sequence),
    sequenceIndex: Number(row.sequence_index)
  }
}

/** The longest event prefix whose touched rows' stored sizes fit, so excluded bodies are never read. */
export function fittingJournalDomainEventCount(
  db: Database.Database,
  head: { sessionId: string; epoch: string },
  rows: readonly JournalReadRow[],
  budgetBytes: number,
  forms: Map<string, HistoryItemForm>
): { limit: number; states: ReadonlyMap<string, unknown>; orderedIds: string[] } {
  const touched = rows.map((row) =>
    row.kind === 'outcome'
      ? [...row.itemIds, ...row.submissionIds.map(agentJournalSubmissionKey)]
      : []
  )
  const sizes = new Map(
    db
      .prepare(`SELECT item.item_id, item.sequence, item.sequence_index, item.ordinal, ${JOURNAL_DOMAIN_HISTORY_ITEM_BYTES} AS bytes,
        CASE WHEN item.wire_version=${AGENT_SESSION_ITEM_WIRE_VERSION} THEN 0
        ELSE ${JOURNAL_DOMAIN_HISTORY_SUBMISSION_BYTES} END AS submission_bytes FROM json_each(?) wanted
        CROSS JOIN journal_items item
        WHERE item.session_id=? AND item.epoch=? AND item.item_id=wanted.value AND item.hidden=0`)
      .all(JSON.stringify([...new Set(touched.flat())]), head.sessionId, head.epoch)
      .map((row) => [String(row.item_id), row])
  )
  const states = readJournalDomainStopStates(
    db,
    head,
    [...sizes].filter(([, row]) => row.bytes === null).map(([id]) => id)
  )
  const counted = new Set<string>()
  let total = 0
  let count = 0
  for (const ids of touched) {
    const fresh = [...new Set(ids)].filter((id) => !counted.has(id))
    const current = readJournalDomainClientForms(
      db,
      head,
      fresh.filter((id) => sizes.get(id)?.bytes === null),
      new Map(),
      states
    )
    const bytes = fresh.reduce((sum, id) => {
      const row = sizes.get(id)
      return (
        sum +
        (row
          ? row.bytes === null
            ? current.get(id)!.bytes + Number(row.submission_bytes)
            : Number(row.bytes)
          : 0)
      )
    }, 0)
    if (count > 0 && total + bytes > budgetBytes) {
      break
    }
    for (const [id, form] of current) {
      forms.set(id, form)
    }
    for (const id of fresh) {
      counted.add(id)
    }
    total += bytes
    count += 1
  }
  return {
    limit: Math.max(count, 1),
    states,
    orderedIds: [...sizes]
      .sort(
        ([, a], [, b]) =>
          Number(a.sequence) - Number(b.sequence) ||
          Number(a.sequence_index) - Number(b.sequence_index) ||
          Number(a.ordinal) - Number(b.ordinal)
      )
      .map(([id]) => id)
  }
}
