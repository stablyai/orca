import { mapMessageRows } from './transcript-opencode-message-rows'
import type { MessageRow } from './transcript-opencode-message-rows'
import { openOpenCodeDatabaseReadonly } from '../ai-vault/session-scanner-opencode-sqlite-open'
import { zcodeVisibleMessageFilter } from '../ai-vault/session-scanner-zcode-visibility'
import { zcodeTranscriptOrder } from '../ai-vault/session-scanner-zcode-order'
import {
  readOpenCode2TranscriptPage,
  readOpenCode2TranscriptSignal
} from './transcript-opencode2-sqlite'
import type { NativeChatMessage, NativeChatTurnLifecycle } from '../../shared/native-chat-types'
import { openCodeTranscriptPageLimit } from '../../shared/opencode-transcript-page-limit'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'
import { asRecord, extractString, parseJsonObject } from '../ai-vault/session-scanner-values'
import type SyncDatabase from '../sqlite/sync-database'
import { rowsOf, rowsWithinBudget } from './transcript-opencode-row-budget'
import { OPENCODE_TRANSCRIPT_MAX_ROW_BYTES } from './transcript-opencode-part-blocks'
export {
  PART_ID_BATCH,
  type MessageRow,
  type PartRow,
  mapMessageRows
} from './transcript-opencode-message-rows'

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
  lifecycle?: NativeChatTurnLifecycle
}

export type OpenCodeTranscriptSignal = {
  cwd?: string | null
  messageCount: number
  partCount: number
  maxMessageRowId: number
  maxPartTimeUpdated: number
}

function sessionExists(db: SyncDatabase, sessionId: string): boolean {
  return (
    tableExists(db, 'session') &&
    db.prepare('SELECT 1 FROM session WHERE id = ?').get(sessionId) != null
  )
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
      cwd: columnExists(db, 'session', 'directory')
        ? extractString(
            asRecord(db.prepare('SELECT directory FROM session WHERE id = ?').get(sessionId))
              ?.directory
          )
        : null,
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
    // Keep stable storage IDs on the wire; ranks exist only inside this query.
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
    // Always bind an upper bound: batching advances it mid-page; MAX_SAFE_INTEGER starts at newest.
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
    let lifecycle: NativeChatTurnLifecycle | undefined
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
      hasMore = rows.length > limit
      const selected = hasMore ? rows.slice(0, limit) : rows
      for (const row of selected) {
        if (lifecycle || row.data === null) {
          continue
        }
        const record = parseJsonObject(row.data)
        const time = asRecord(record?.time)
        if (record?.role === 'user') {
          lifecycle = { state: 'working', turnId: row.id, timestamp: row.time_created }
        } else if (
          record?.role === 'assistant' &&
          typeof record.parentID === 'string' &&
          typeof time?.completed === 'number'
        ) {
          const error = asRecord(record.error)
          const state =
            error?.name === 'MessageAbortedError'
              ? 'interrupted'
              : error || record.finish === 'error'
                ? 'failed'
                : typeof record.finish === 'string' &&
                    record.finish !== 'tool-calls' &&
                    record.finish !== 'unknown'
                  ? 'completed'
                  : null
          if (state) {
            lifecycle = {
              state: state === 'failed' ? 'completed' : state,
              ...(state === 'failed' ? { outcome: 'failure' as const } : {}),
              turnId: record.parentID,
              timestamp: time.completed
            }
          }
        }
      }
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
    // Raw-row cursors cannot resume inside a reasoning/answer pair.
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
      beforeMessageRowId: overshot ? items[0]!.rowid : (cursor ?? null),
      ...(lifecycle ? { lifecycle } : {})
    }
  } finally {
    db.close()
  }
}
