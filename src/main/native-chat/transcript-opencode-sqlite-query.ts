import { openOpenCodeDatabaseReadonly } from '../ai-vault/session-scanner-opencode-sqlite-open'
import { zcodeVisibleMessageFilter } from '../ai-vault/session-scanner-zcode-visibility'
import { zcodeTranscriptOrder } from '../ai-vault/session-scanner-zcode-order'
import {
  readOpenCode2TranscriptPage,
  readOpenCode2TranscriptSignal
} from './transcript-opencode2-sqlite'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { openCodeTranscriptPageLimit } from '../../shared/opencode-transcript-page-limit'
import { extractString, parseJsonObject } from '../ai-vault/session-scanner-values'
import type SyncDatabase from '../sqlite/sync-database'

type BindValue = SyncDatabase.BindValue
type SqliteStatement = SyncDatabase.Statement
import {
  opencodeMessages,
  OPENCODE_TRANSCRIPT_MAX_ROW_BYTES
} from './transcript-opencode-part-blocks'
// Cursors are opaque provider order: SQLite rowid in v1, session sequence in v2.

export type OpenCodeTranscriptItem = {
  rowid: number
  fingerprint: string
  message: NativeChatMessage
}

export type OpenCodeTranscriptPage = {
  items: OpenCodeTranscriptItem[]
  hasMore: boolean
  beforeMessageRowId: number | null
}

export type OpenCodeTranscriptSignal = {
  messageCount: number
  partCount: number
  maxMessageRowId: number
  maxPartTimeUpdated: number
}

const PART_ID_BATCH = 100

function sessionExists(db: SyncDatabase, sessionId: string): boolean {
  const table = rowsOf<{ name: string }>(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'")
  )
  return table.length > 0 && db.prepare('SELECT 1 FROM session WHERE id = ?').get(sessionId) != null
}

function rowsOf<T>(statement: SqliteStatement, ...params: BindValue[]): T[] {
  return rowsWithinBudget<T>(statement, { bytes: 0 }, ...params)
}

function rowsWithinBudget<T>(
  statement: SqliteStatement,
  budget: { bytes: number },
  ...params: BindValue[]
): T[] {
  const rows: ReturnType<SqliteStatement['all']> = []
  for (const row of statement.iterate(...params)) {
    budget.bytes += Object.values(row).reduce<number>(
      (size, value) => size + (typeof value === 'string' ? Buffer.byteLength(value) : 0),
      0
    )
    if (rows.length >= 10000 || budget.bytes > 16 * 1024 * 1024) {
      throw new Error('OpenCode transcript query exceeds its read limit')
    }
    rows.push(row)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Each caller names the columns projected by its internal SQL query.
  return rows as T[]
}

export function readOpenCodeTranscriptSignal(
  dbPath: string,
  sessionId: string,
  agent?: 'zcode'
): OpenCodeTranscriptSignal | null {
  const db = openOpenCodeDatabaseReadonly(dbPath)
  try {
    const v2 = readOpenCode2TranscriptSignal(db, sessionId)
    if (v2) {
      return v2
    }
    if (!sessionExists(db, sessionId)) {
      return null
    }
    // Aggregates without GROUP BY always yield exactly one row, so [0] is it.
    const visibility = zcodeVisibleMessageFilter(agent ?? 'opencode', 'data')
    const [messageRow] = rowsOf<{
      message_count: number
      max_message_rowid: number
      max_message_time_updated: number
    }>(
      db.prepare(
        `SELECT COUNT(*) AS message_count, COALESCE(MAX(rowid), 0) AS max_message_rowid,
         COALESCE(MAX(time_updated), 0) AS max_message_time_updated
         FROM message WHERE session_id = ? ${visibility}`
      ),
      sessionId
    )
    const [partRow] = rowsOf<{ part_count: number; max_part_time_updated: number }>(
      db.prepare(
        `SELECT COUNT(*) AS part_count, COALESCE(MAX(time_updated), 0) AS max_part_time_updated
         FROM part WHERE session_id = ? ${
           agent === 'zcode'
             ? `AND message_id IN (
           SELECT id FROM message WHERE session_id = ? ${visibility}
         )`
             : ''
         }`
      ),
      sessionId,
      ...(agent === 'zcode' ? [sessionId] : [])
    )
    return {
      messageCount: messageRow?.message_count ?? 0,
      partCount: partRow?.part_count ?? 0,
      maxMessageRowId: messageRow?.max_message_rowid ?? 0,
      maxPartTimeUpdated: Math.max(
        partRow?.max_part_time_updated ?? 0,
        agent === 'zcode' ? (messageRow?.max_message_time_updated ?? 0) : 0
      )
    }
  } finally {
    db.close()
  }
}

export function readOpenCodeTranscriptPage(args: {
  dbPath: string
  sessionId: string
  limit: number
  beforeMessageRowId?: number
  agent?: 'zcode'
}): OpenCodeTranscriptPage | null {
  const db = openOpenCodeDatabaseReadonly(args.dbPath)
  try {
    const v2 = readOpenCode2TranscriptPage(db, args)
    if (v2) {
      return v2
    }
    if (!sessionExists(db, args.sessionId)) {
      return null
    }
    const limit = openCodeTranscriptPageLimit(args.limit)
    // Rank only inside the query; wire cursors retain the stable storage row identity.
    const ranked = args.agent === 'zcode'
    const orderColumn = ranked ? 'ordered.transcript_order' : 'm.rowid'
    if (
      ranked &&
      args.beforeMessageRowId !== undefined &&
      !db
        .prepare('SELECT 1 FROM message WHERE session_id = ? AND rowid = ?')
        .get(args.sessionId, args.beforeMessageRowId)
    ) {
      throw new Error('Transcript pagination cursor was removed; reload the conversation')
    }
    const ordered = ranked
      ? `WITH ordered AS (
      SELECT m.rowid AS storage_rowid, ROW_NUMBER() OVER (
        ORDER BY ${zcodeTranscriptOrder(db, 'zcode', 'message', 'm', 'ASC')}
      ) AS transcript_order FROM message m WHERE session_id = ?
    )`
      : ''
    // The upper bound is always bound: batching advances the cursor mid-page,
    // so the statement cannot vary with `beforeMessageRowId`'s presence.
    // MAX_SAFE_INTEGER is the "from the newest row" sentinel.
    const select = db.prepare(
      `${ordered} SELECT m.rowid AS message_rowid, ${orderColumn} AS transcript_order, m.id, m.time_created, m.time_updated, CASE WHEN length(CAST(m.data AS BLOB)) <= ${OPENCODE_TRANSCRIPT_MAX_ROW_BYTES} THEN m.data ELSE NULL END AS data
         FROM message m ${ranked ? 'JOIN ordered ON ordered.storage_rowid = m.rowid' : ''}
         WHERE m.session_id = ? AND ${orderColumn} < ${ranked ? 'COALESCE((SELECT transcript_order FROM ordered WHERE storage_rowid = ?), 9007199254740991)' : '?'} ${zcodeVisibleMessageFilter(args.agent ?? 'opencode')}
         ORDER BY ${orderColumn} DESC
         LIMIT ?`
    )
    const collected: OpenCodeTranscriptItem[] = []
    let scannedRows = 0
    let pageBytes = 0
    const rawBudget = { bytes: 0 }
    let cursor: number | undefined = args.beforeMessageRowId
    let hasMore = false
    for (;;) {
      const rows = rowsWithinBudget<MessageRow>(
        select,
        rawBudget,
        ...(ranked ? [args.sessionId] : []),
        args.sessionId,
        cursor ?? Number.MAX_SAFE_INTEGER,
        limit + 1
      )
      scannedRows += rows.length
      if (scannedRows > 10_000) {
        throw new Error('OpenCode transcript page exceeds its scan limit')
      }
      if (rows.length === 0) {
        break
      }
      // The (limit+1)th row is only a hasMore probe — never decoded.
      hasMore = rows.length > limit
      const selected = hasMore ? rows.slice(0, limit) : rows
      cursor = selected.at(-1)!.message_rowid
      const mapped = mapMessageRows(db, args.sessionId, selected, rawBudget, args.agent)
      pageBytes += Buffer.byteLength(JSON.stringify(mapped))
      if (pageBytes > 16 * 1024 * 1024) {
        throw new Error('OpenCode transcript page exceeds its byte limit')
      }
      collected.push(...mapped)
      if (!hasMore || collected.length >= limit) {
        break
      }
    }
    let retained = Math.min(limit, collected.length)
    // A raw-row cursor cannot resume inside a reasoning/answer pair.
    while (
      retained < collected.length &&
      collected[retained].rowid === collected[retained - 1].rowid
    ) {
      retained++
    }
    const overshot = retained < collected.length
    const trimmed = overshot ? collected.slice(0, retained) : collected
    const items = trimmed.toReversed()
    return {
      items,
      hasMore: hasMore || overshot,
      beforeMessageRowId: overshot ? items[0]!.rowid : (cursor ?? null)
    }
  } finally {
    db.close()
  }
}

type MessageRow = {
  message_rowid: number
  transcript_order: number
  id: string
  time_created: number
  time_updated: number
  data: string | null
}

type PartRow = {
  message_id: string
  time_updated: number
  data: string | null
}

function mapMessageRows(
  db: SyncDatabase,
  sessionId: string,
  rows: MessageRow[],
  rawBudget: { bytes: number },
  agent?: 'zcode'
): OpenCodeTranscriptItem[] {
  if (rows.length === 0) {
    return []
  }
  const partsByMessage = new Map<string, PartRow[]>()
  const ids = rows.map((row) => row.id)
  for (let start = 0; start < ids.length; start += PART_ID_BATCH) {
    const batch = ids.slice(start, start + PART_ID_BATCH)
    const placeholders = batch.map(() => '?').join(', ')
    const partRows = rowsWithinBudget<PartRow>(
      db.prepare(
        `SELECT message_id, time_updated, CASE WHEN length(CAST(data AS BLOB)) <= ${OPENCODE_TRANSCRIPT_MAX_ROW_BYTES} THEN data ELSE NULL END AS data FROM part p
         WHERE session_id = ? AND message_id IN (${placeholders})
         ORDER BY ${agent === 'zcode' ? zcodeTranscriptOrder(db, agent, 'part', 'p', 'ASC') : 'rowid'} LIMIT 10001`
      ),
      rawBudget,
      sessionId,
      ...batch
    )
    if (partRows.length > 10000) {
      throw new Error('OpenCode transcript parts exceed their read limit')
    }
    for (const partRow of partRows) {
      const list = partsByMessage.get(partRow.message_id)
      if (list) {
        list.push(partRow)
      } else {
        partsByMessage.set(partRow.message_id, [partRow])
      }
    }
  }
  const items: OpenCodeTranscriptItem[] = []
  for (const row of rows) {
    const partList = partsByMessage.get(row.id) ?? []
    const record = row.data === null ? null : parseJsonObject(row.data)
    const role = extractString(record?.role)
    const messages = opencodeMessages(
      {
        id: row.id,
        role: role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'system',
        timestamp: Number.isFinite(row.time_created) ? row.time_created : null
      },
      row.data === null
        ? [{ message_id: row.id, time_updated: row.time_updated, data: null }]
        : partList
    )
    for (const message of messages.toReversed()) {
      items.push({
        rowid: row.message_rowid,
        fingerprint: `${row.time_updated}:${partList.length}:${maxPartTimeUpdated(partList)}`,
        message: {
          ...message,
          transcriptOffset: row.message_rowid,
          ...(agent === 'zcode' ? { transcriptOrder: row.transcript_order } : {})
        }
      })
    }
  }
  return items
}

function maxPartTimeUpdated(partRows: PartRow[]): number {
  let max = 0
  for (const partRow of partRows) {
    if (partRow.time_updated > max) {
      max = partRow.time_updated
    }
  }
  return max
}
