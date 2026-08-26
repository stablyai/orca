import type {
  NativeChatBlock,
  NativeChatMessage,
  NativeChatRole
} from '../../shared/native-chat-types'
import type { OpenCodeSqliteTranscriptValue } from './session-scanner-opencode-sqlite-worker-protocol'
import SyncDatabase from '../sqlite/sync-database'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MAX_TEXT_CHARS = 256 * 1024
const MAX_TOOL_VALUE_CHARS = 64 * 1024

type TranscriptRow = {
  row_id: number
  part_id: string
  message_id: string
  role: string | null
  turn_id: string | null
  part_type: string
  text_value: string | null
  tool_name: string | null
  tool_status: string | null
  tool_input: string | null
  tool_output: string | null
  time_created: number
}

export function readZcodeSqliteTranscript(args: {
  dbPath: string
  sessionId: string
  offset?: number
  endOffset?: number
  beforeOffset?: number
  limit: number
}): OpenCodeSqliteTranscriptValue {
  const db = new SyncDatabase(args.dbPath, { readonly: true, fileMustExist: true })
  db.pragma('query_only = ON')
  try {
    const sourceMax = Number(
      (
        db
          .prepare('SELECT COALESCE(MAX(rowid), 0) AS value FROM part WHERE session_id = ?')
          .get(args.sessionId) as { value: number }
      ).value
    )
    if (
      (args.endOffset !== undefined && sourceMax < args.endOffset) ||
      (args.offset ?? 0) > sourceMax
    ) {
      throw new Error('ZCODE_TRANSCRIPT_SOURCE_CHANGED')
    }

    const boundary = Math.min(
      sourceMax,
      args.endOffset ?? Number.MAX_SAFE_INTEGER,
      args.beforeOffset === undefined ? Number.MAX_SAFE_INTEGER : args.beforeOffset - 1
    )
    const requestedLimit = Math.max(1, Math.trunc(args.limit))
    const rows = readRows(db, args.sessionId, args.offset, boundary, requestedLimit + 1)
    const limited = rows.length > requestedLimit
    const pageRows =
      args.offset === undefined ? rows.slice(-requestedLimit) : rows.slice(0, requestedLimit)
    const messages = pageRows
      .map(decodeRow)
      .filter((message): message is NativeChatMessage => message !== null)
    const nextOffset = pageRows.at(-1)?.row_id ?? args.offset ?? boundary
    const beforeOffset = pageRows[0]?.row_id ?? boundary
    return { messages, nextOffset, beforeOffset, limited, warnings: [] }
  } finally {
    db.close()
  }
}

export function resolveZcodeSqliteDbPath(transcriptPath?: string): string {
  return transcriptPath && /\.(?:db|sqlite)$/i.test(transcriptPath)
    ? transcriptPath
    : join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite')
}

function readRows(
  db: SyncDatabase,
  sessionId: string,
  offset: number | undefined,
  boundary: number,
  limit: number
): TranscriptRow[] {
  const select = `SELECT p.rowid AS row_id,
                         p.id AS part_id,
                         p.message_id,
                         json_extract(m.data, '$.role') AS role,
                         json_extract(m.data, '$.anchor.turnId') AS turn_id,
                         json_extract(p.data, '$.type') AS part_type,
                         substr(json_extract(p.data, '$.text'), 1, ${MAX_TEXT_CHARS}) AS text_value,
                         json_extract(p.data, '$.tool') AS tool_name,
                         json_extract(p.data, '$.state.status') AS tool_status,
                         substr(json_extract(p.data, '$.state.input'), 1, ${MAX_TOOL_VALUE_CHARS}) AS tool_input,
                         substr(json_extract(p.data, '$.state.output'), 1, ${MAX_TOOL_VALUE_CHARS}) AS tool_output,
                         p.time_created
                  FROM part p
                  JOIN message m ON m.id = p.message_id
                  WHERE p.session_id = ?
                    AND p.rowid <= ?
                    AND json_extract(p.data, '$.type') IN ('text', 'reasoning', 'tool')
                    AND COALESCE(json_extract(m.data, '$.semantics.transcriptVisibility'), 'visible') != 'hidden'`
  if (offset !== undefined) {
    return db
      .prepare(`${select} AND p.rowid > ? ORDER BY p.rowid ASC LIMIT ?`)
      .all(sessionId, boundary, offset, limit) as TranscriptRow[]
  }
  const rows = db
    .prepare(`${select} ORDER BY p.rowid DESC LIMIT ?`)
    .all(sessionId, boundary, limit) as TranscriptRow[]
  return rows.toReversed()
}

function decodeRow(row: TranscriptRow): NativeChatMessage | null {
  const blocks: NativeChatBlock[] = []
  let role: NativeChatRole
  if (row.part_type === 'tool') {
    role = 'tool'
    blocks.push({
      type: 'tool-call',
      name: row.tool_name?.trim() || 'tool',
      input: parseJsonValue(row.tool_input)
    })
    if (row.tool_status === 'completed' || row.tool_status === 'error') {
      blocks.push({
        type: 'tool-result',
        output: row.tool_output ?? '',
        ...(row.tool_status === 'error' ? { isError: true } : {})
      })
    }
  } else {
    const text = row.text_value ?? ''
    if (!text) {
      return null
    }
    role = row.part_type === 'reasoning' ? 'reasoning' : normalizeRole(row.role)
    blocks.push({ type: 'text', text })
  }
  return {
    id: `zcode:${row.part_id}`,
    role,
    blocks,
    timestamp: row.time_created,
    source: 'transcript',
    ...(row.turn_id ? { turnId: row.turn_id } : {})
  }
}

function normalizeRole(role: string | null): NativeChatRole {
  return role === 'user' || role === 'assistant' || role === 'system' ? role : 'assistant'
}

function parseJsonValue(value: string | null): unknown {
  if (value === null) {
    return null
  }
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}
