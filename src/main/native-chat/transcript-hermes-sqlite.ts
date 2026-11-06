import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { openOpenCodeDatabaseReadonly } from '../ai-vault/scanners/opencode/sqlite/session-scanner-opencode-sqlite-open'
import { asRecord, extractString, timestampMs } from '../ai-vault/session-scanner-values'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'
import type { NativeChatBlock, NativeChatMessage } from '../../shared/native-chat/native-chat-types'
import { openCodeTranscriptPageLimit } from '../../shared/opencode-transcript-page-limit'
import { agentSessionHostStatusBody } from '../../shared/agent-session/view/agent-session-host-status-rows'
import { claudeContentBlocks, toolResultOutput } from './transcript-record-blocks'
import { OPENCODE_TRANSCRIPT_MAX_ROW_BYTES } from './transcript-opencode-part-blocks'
import { rowsOf } from './transcript-opencode-row-budget'
import type {
  OpenCodeTranscriptItem,
  OpenCodeTranscriptPage,
  OpenCodeTranscriptSignal
} from './transcript-opencode-sqlite-query'
import type SyncDatabase from '../sqlite/sync-database'

type HermesMessageRow = {
  id: number
  role: string
  content: string | null
  tool_calls: string | null
  content_omitted: number
  tool_calls_omitted: number
  tool_call_id: string | null
  timestamp: number
}

function boundedHermesText(column: 'content' | 'tool_calls'): string {
  const limit = OPENCODE_TRANSCRIPT_MAX_ROW_BYTES
  return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${limit} THEN ${column} ELSE NULL END AS ${column}, CASE WHEN length(CAST(${column} AS BLOB)) > ${limit} THEN 1 ELSE 0 END AS ${column}_omitted`
}

const HERMES_TRANSCRIPT_PAGE_BYTES = 16 * 1024 * 1024

function readHermesPageRows(
  statement: SyncDatabase.Statement,
  ...params: SyncDatabase.BindValue[]
): { rows: HermesMessageRow[]; truncated: boolean } {
  const rows: HermesMessageRow[] = []
  let bytes = 0
  for (const row of statement.iterate(...params)) {
    const size = Object.values(row).reduce<number>(
      (total, value) => total + (typeof value === 'string' ? Buffer.byteLength(value) : 0),
      0
    )
    if (rows.length > 0 && bytes + size > HERMES_TRANSCRIPT_PAGE_BYTES) {
      return { rows, truncated: true }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The page query projects HermesMessageRow columns.
    rows.push(row as HermesMessageRow)
    bytes += size
  }
  return { rows, truncated: false }
}

function visibleRows(db: SyncDatabase): string {
  const active = columnExists(db, 'messages', 'active')
  const compacted = columnExists(db, 'messages', 'compacted')
  return active ? (compacted ? ' AND (active = 1 OR compacted = 1)' : ' AND active = 1') : ''
}

function sessionExists(db: SyncDatabase, sessionId: string): boolean {
  return (
    tableExists(db, 'sessions') &&
    tableExists(db, 'messages') &&
    db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId) != null
  )
}

function changedAt(path: string): number {
  const file = statSync(path, { throwIfNoEntry: false })
  const wal = statSync(`${path}-wal`, { throwIfNoEntry: false })
  return Math.max(file?.mtimeMs ?? 0, wal?.mtimeMs ?? 0)
}

export function readHermesTranscriptSignal(
  dbPath: string,
  sessionId: string
): OpenCodeTranscriptSignal | null {
  const db = openOpenCodeDatabaseReadonly(dbPath)
  try {
    if (!sessionExists(db, sessionId)) {
      return null
    }
    const [row] = rowsOf<{ count: number; max_id: number }>(
      db.prepare(
        `SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS max_id FROM messages WHERE session_id = ?${visibleRows(db)}`
      ),
      sessionId
    )
    return {
      messageCount: row?.count ?? 0,
      partCount: 0,
      maxMessageRowId: row?.max_id ?? 0,
      maxPartTimeUpdated: changedAt(dbPath)
    }
  } finally {
    db.close()
  }
}

function toolCalls(value: string | null): NativeChatBlock[] {
  if (!value) {
    return []
  }
  let calls: unknown
  try {
    calls = JSON.parse(value)
  } catch {
    return []
  }
  if (!Array.isArray(calls)) {
    return []
  }
  return calls.flatMap((entry): NativeChatBlock[] => {
    const call = asRecord(entry)
    const fn = asRecord(call?.function)
    const name = extractString(fn?.name) ?? extractString(call?.name)
    if (!name) {
      return []
    }
    let input: unknown = fn?.arguments ?? call?.arguments
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input)
      } catch {
        /* Preserve the provider's text. */
      }
    }
    const callId = extractString(call?.id)
    return [{ type: 'tool-call', name, input, ...(callId ? { callId } : {}) }]
  })
}

function hermesContent(value: string | null): unknown {
  if (!value?.startsWith('\0json:')) {
    return value
  }
  try {
    return JSON.parse(value.slice(6))
  } catch {
    return value
  }
}

function omittedHermesText(): NativeChatBlock {
  const { text, presentation } = agentSessionHostStatusBody('history-item-too-large')
  return { type: 'text', text, presentation }
}

function decodeRow(row: HermesMessageRow): NativeChatMessage | null {
  let blocks: NativeChatBlock[]
  if (row.role === 'tool') {
    blocks = [
      {
        type: 'tool-result',
        output: row.content_omitted
          ? agentSessionHostStatusBody('history-item-too-large').text
          : toolResultOutput(hermesContent(row.content)),
        ...(row.tool_call_id ? { callId: row.tool_call_id } : {})
      }
    ]
  } else if (row.role === 'assistant' || row.role === 'user') {
    blocks = [
      ...(row.content_omitted
        ? [omittedHermesText()]
        : claudeContentBlocks(hermesContent(row.content))),
      ...(row.role === 'assistant'
        ? row.tool_calls_omitted
          ? [omittedHermesText()]
          : toolCalls(row.tool_calls)
        : [])
    ]
  } else {
    return null
  }
  if (blocks.length === 0) {
    return null
  }
  const timestamp = timestampMs(row.timestamp)
  return {
    id: `hermes:${row.id}`,
    role: row.role,
    blocks,
    timestamp: Number.isFinite(timestamp) ? timestamp : null,
    source: 'transcript',
    transcriptOffset: row.id,
    transcriptOrder: row.id
  }
}

export function readHermesTranscriptPage(args: {
  dbPath: string
  sessionId: string
  limit: number
  beforeMessageRowId?: number
}): OpenCodeTranscriptPage | null {
  const db = openOpenCodeDatabaseReadonly(args.dbPath)
  try {
    if (!sessionExists(db, args.sessionId)) {
      return null
    }
    const limit = openCodeTranscriptPageLimit(args.limit)
    const loaded = readHermesPageRows(
      db.prepare(
        `SELECT id, role, ${boundedHermesText('content')}, ${boundedHermesText('tool_calls')}, tool_call_id, timestamp FROM messages WHERE session_id = ?${visibleRows(db)} AND role IN ('user','assistant','tool') AND id < ? ORDER BY id DESC LIMIT ?`
      ),
      args.sessionId,
      args.beforeMessageRowId ?? Number.MAX_SAFE_INTEGER,
      limit + 1
    )
    const hasMore = loaded.truncated || loaded.rows.length > limit
    const selected = loaded.rows.slice(0, limit).toReversed()
    const items: OpenCodeTranscriptItem[] = selected.flatMap((row) => {
      const message = decodeRow(row)
      return message
        ? [
            {
              rowid: row.id,
              fingerprint: createHash('sha256').update(JSON.stringify(row)).digest('hex'),
              message
            }
          ]
        : []
    })
    return { items, hasMore, beforeMessageRowId: selected[0]?.id ?? null }
  } finally {
    db.close()
  }
}
