import { createHash } from 'node:crypto'
import type SyncDatabase from '../sqlite/sync-database'
import { openCodeTranscriptPageLimit } from '../../shared/opencode-transcript-page-limit'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'
import { asRecord, parseJsonObject } from '../ai-vault/session-scanner-values'
import {
  opencodeMessages,
  OPENCODE_TRANSCRIPT_MAX_ROW_BYTES
} from './transcript-opencode-part-blocks'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import type {
  OpenCodeTranscriptPage,
  OpenCodeTranscriptSignal,
  OpenCodeTranscriptItem
} from './transcript-opencode-sqlite-query'

const MAX_PAGE_BYTES = 16 * 1024 * 1024
const MAX_SCAN_ROWS = 10_000

function sessionExists(db: SyncDatabase, sessionId: string): boolean {
  return (
    tableExists(db, 'session_v2') &&
    tableExists(db, 'session_message') &&
    ['id', 'session_id', 'type', 'seq', 'data', 'time_created', 'time_updated'].every((column) =>
      columnExists(db, 'session_message', column)
    ) &&
    db.prepare('SELECT 1 FROM session_v2 WHERE id = ?').get(sessionId) != null
  )
}

export function readOpenCode2TranscriptSignal(
  db: SyncDatabase,
  sessionId: string
): OpenCodeTranscriptSignal | null {
  if (!sessionExists(db, sessionId)) {
    return null
  }
  const row = asRecord(
    db
      .prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(seq), 0) AS latest,
    COALESCE(MAX(time_updated), 0) AS updated FROM session_message WHERE session_id = ?`)
      .get(sessionId)
  )
  if (
    typeof row?.count !== 'number' ||
    typeof row.latest !== 'number' ||
    typeof row.updated !== 'number'
  ) {
    throw new Error('OpenCode transcript signal is invalid')
  }
  return {
    messageCount: row.count,
    partCount: 0,
    maxMessageRowId: row.latest,
    maxPartTimeUpdated: row.updated
  }
}

function messageItems(value: unknown): OpenCodeTranscriptItem[] {
  const row = asRecord(value)
  if (
    typeof row?.id !== 'string' ||
    typeof row.cursor !== 'number' ||
    typeof row.time_created !== 'number' ||
    typeof row.time_updated !== 'number'
  ) {
    throw new Error('OpenCode transcript message is invalid')
  }
  const messageCursor = row.cursor
  const updatedAt = row.time_updated
  if (
    row.data === null ||
    (typeof row.data === 'string' &&
      Buffer.byteLength(row.data) > OPENCODE_TRANSCRIPT_MAX_ROW_BYTES)
  ) {
    return opencodeMessages(
      {
        id: `opencode:${row.id}`,
        role: 'system',
        timestamp: row.time_created
      },
      [{ message_id: row.id, time_updated: row.time_updated, data: null }]
    ).map((message) => ({
      rowid: messageCursor,
      fingerprint: `${updatedAt}:omitted`,
      message: { ...message, transcriptOffset: messageCursor }
    }))
  }
  if (typeof row.data !== 'string') {
    throw new Error('OpenCode transcript message is invalid')
  }
  const messageId = row.id
  const record = parseJsonObject(row.data)
  if (!record) {
    throw new Error('OpenCode transcript message contains invalid JSON')
  }
  const content = Array.isArray(record.content)
    ? record.content
    : typeof record.text === 'string'
      ? [{ type: 'text', text: record.text }]
      : []
  if (row.type === 'user' && Array.isArray(record.files)) {
    for (const file of record.files) {
      const attachment = asRecord(file)
      if (!attachment) {
        continue
      }
      const url =
        typeof attachment.uri === 'string'
          ? attachment.uri
          : typeof attachment.data === 'string' && typeof attachment.mime === 'string'
            ? `data:${attachment.mime};base64,${attachment.data}`
            : null
      if (url) {
        content.push({ type: 'file', url, mime: attachment.mime, filename: attachment.name })
      }
    }
  }
  const parts = content.flatMap((value) => {
    const item = asRecord(value)
    if (!item) {
      return []
    }
    if (item.type !== 'tool') {
      return [{ message_id: messageId, time_updated: updatedAt, data: JSON.stringify(item) }]
    }
    const state = asRecord(item.state)
    const output = Array.isArray(state?.content)
      ? state.content
          .flatMap((value) => {
            const part = asRecord(value)
            return typeof part?.text === 'string' ? [part.text] : []
          })
          .join('\n')
      : undefined
    return [
      {
        message_id: messageId,
        time_updated: updatedAt,
        data: JSON.stringify({ ...item, tool: item.name, state: { ...state, output } })
      }
    ]
  })
  const blocks: NativeChatBlock[] = []
  const error = asRecord(record.error)
  if (typeof error?.message === 'string') {
    blocks.push({ type: 'text', text: error.message })
  }
  if (row.type === 'idle' && record.outcome === 'interrupted') {
    blocks.push({ type: 'text', text: 'Conversation interrupted' })
  }
  if (
    row.type !== 'user' &&
    row.type !== 'assistant' &&
    row.type !== 'system' &&
    row.type !== 'idle'
  ) {
    return []
  }
  const messages = opencodeMessages(
    {
      id: `opencode:${row.id}`,
      role: row.type === 'idle' ? 'system' : row.type,
      timestamp: row.time_created
    },
    parts,
    blocks
  )
  const fingerprint = `${updatedAt}:${createHash('sha256').update(row.data).digest('hex')}`
  return messages.toReversed().map((message) => ({
    rowid: messageCursor,
    fingerprint,
    message: { ...message, transcriptOffset: messageCursor }
  }))
}

export function readOpenCode2TranscriptPage(
  db: SyncDatabase,
  args: {
    sessionId: string
    limit: number
    beforeMessageRowId?: number
  }
): OpenCodeTranscriptPage | null {
  if (!sessionExists(db, args.sessionId)) {
    return null
  }
  const limit = openCodeTranscriptPageLimit(args.limit)
  const statement = db.prepare(`SELECT seq AS cursor, id, type, time_created, time_updated,
    CASE WHEN length(CAST(data AS BLOB)) <= ${OPENCODE_TRANSCRIPT_MAX_ROW_BYTES} THEN data ELSE NULL END AS data
    FROM session_message WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`)
  const items: OpenCodeTranscriptItem[] = []
  let cursor = args.beforeMessageRowId ?? Number.MAX_SAFE_INTEGER
  let scannedRows = 0
  let bytes = 0
  let pageBytes = 0
  let hasMore = false
  while (items.length < limit) {
    const rows = statement.all(args.sessionId, cursor, Math.min(limit + 1, 8))
    hasMore = rows.length === Math.min(limit + 1, 8)
    if (rows.length === 0) {
      break
    }
    for (const value of rows) {
      const row = asRecord(value)
      if (typeof row?.cursor !== 'number') {
        throw new Error('OpenCode transcript cursor is invalid')
      }
      bytes += Object.values(row).reduce<number>(
        (size, value) => size + (typeof value === 'string' ? Buffer.byteLength(value) : 0),
        0
      )
      if (++scannedRows > MAX_SCAN_ROWS || bytes > MAX_PAGE_BYTES) {
        throw new Error('OpenCode transcript page exceeds its read limit')
      }
      const mapped = messageItems(value)
      cursor = row.cursor
      for (const item of mapped) {
        pageBytes += Buffer.byteLength(JSON.stringify(item))
        if (pageBytes > MAX_PAGE_BYTES) {
          throw new Error('OpenCode transcript page exceeds its read limit')
        }
        items.push(item)
      }
      if (items.length >= limit) {
        hasMore =
          db
            .prepare('SELECT 1 FROM session_message WHERE session_id = ? AND seq < ? LIMIT 1')
            .get(args.sessionId, cursor) != null
        break
      }
    }
    if (!hasMore) {
      break
    }
  }
  return { items: items.toReversed(), hasMore, beforeMessageRowId: scannedRows ? cursor : null }
}
