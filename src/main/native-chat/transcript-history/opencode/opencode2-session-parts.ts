import type SyncDatabase from '../../../sqlite/sync-database'
import { columnExists, tableExists } from '../../../opencode-usage/schema-helpers'
import { parseJsonObject } from '../../../ai-vault/parsing/session-json-object'
import { asRecord } from '../../../ai-vault/parsing/session-record-fields'

// OpenCode 2.4 saves each assistant part as a session_part row and leaves the message's
// `content` empty; 2.3.x rows keep their parts inline and are returned untouched.

const PART_COLUMNS = ['message_id', 'session_id', 'ordinal', 'data', 'time_updated']
// Stays well under SQLite's bound-parameter limit.
const MESSAGE_IDS_PER_QUERY = 500

type OpenCode2MessageRow = { id?: unknown; type?: unknown; data?: unknown }

// Readers open one read-only connection per request, so the schema cannot change under one.
const sessionPartsByDb = new WeakMap<SyncDatabase, boolean>()

function hasSessionParts(db: SyncDatabase): boolean {
  let known = sessionPartsByDb.get(db)
  if (known === undefined) {
    known =
      tableExists(db, 'session_part') &&
      PART_COLUMNS.every((column) => columnExists(db, 'session_part', column))
    sessionPartsByDb.set(db, known)
  }
  return known
}

/** Rows with each assistant message's session_part rows as its `content`, in ordinal order.
 *  With `maxDataBytes`, a message whose parts outgrow it gets `data: null`, as an oversized row. */
export function withOpenCode2SessionParts<T extends OpenCode2MessageRow | null>(
  db: SyncDatabase,
  sessionId: string,
  rows: readonly T[],
  maxDataBytes?: number
): T[] {
  const records = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    if (row?.type !== 'assistant' || typeof row.id !== 'string' || typeof row.data !== 'string') {
      continue
    }
    const record = parseJsonObject(row.data)
    if (Array.isArray(record?.content) && record.content.length === 0) {
      records.set(row.id, record)
    }
  }
  if (records.size === 0 || !hasSessionParts(db)) {
    return [...rows]
  }
  const partData =
    maxDataBytes === undefined
      ? 'data'
      : `CASE WHEN length(CAST(data AS BLOB)) <= ${maxDataBytes} THEN data ELSE NULL END AS data`
  const parts = new Map<string, unknown[] | null>()
  const sizes = new Map<string, number>()
  const ids = [...records.keys()]
  for (let offset = 0; offset < ids.length; offset += MESSAGE_IDS_PER_QUERY) {
    const batch = ids.slice(offset, offset + MESSAGE_IDS_PER_QUERY)
    const statement = db.prepare(`SELECT message_id, ${partData} FROM session_part
      WHERE session_id = ? AND message_id IN (${batch.map(() => '?').join(',')})
      ORDER BY message_id, ordinal`)
    for (const value of statement.iterate(sessionId, ...batch)) {
      const row = asRecord(value)
      const messageId = row?.message_id
      const data = row?.data
      if (typeof messageId !== 'string' || parts.get(messageId) === null) {
        continue
      }
      const size =
        (sizes.get(messageId) ?? 0) + (typeof data === 'string' ? Buffer.byteLength(data) : 0)
      sizes.set(messageId, size)
      if (typeof data !== 'string' || (maxDataBytes !== undefined && size > maxDataBytes)) {
        parts.set(messageId, null)
        continue
      }
      const part = parseJsonObject(data)
      if (part) {
        const list = parts.get(messageId) ?? []
        list.push(part)
        parts.set(messageId, list)
      }
    }
  }
  return rows.map((row) => {
    const id = row?.id
    const record = typeof id === 'string' ? records.get(id) : undefined
    const content = typeof id === 'string' ? parts.get(id) : undefined
    if (!record || content === undefined) {
      return row
    }
    return { ...row, data: content === null ? null : JSON.stringify({ ...record, content }) }
  })
}

/** session_part totals, so readers that watch messages also see parts stream in. */
export function readOpenCode2SessionPartSignal(
  db: SyncDatabase,
  sessionId: string
): { count: number; updated: number } {
  if (!hasSessionParts(db)) {
    return { count: 0, updated: 0 }
  }
  const row = asRecord(
    db
      .prepare(
        'SELECT COUNT(*) AS count, COALESCE(MAX(time_updated), 0) AS updated FROM session_part WHERE session_id = ?'
      )
      .get(sessionId)
  )
  if (typeof row?.count !== 'number' || typeof row.updated !== 'number') {
    throw new Error('OpenCode transcript signal is invalid')
  }
  return { count: row.count, updated: row.updated }
}
