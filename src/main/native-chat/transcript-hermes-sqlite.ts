import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { openOpenCodeDatabaseReadonly } from '../ai-vault/session-scanner-opencode-sqlite-open'
import { asRecord, extractString, timestampMs } from '../ai-vault/session-scanner-values'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'
import type { NativeChatBlock, NativeChatMessage } from '../../shared/native-chat/native-chat-types'
import { openCodeTranscriptPageLimit } from '../../shared/opencode-transcript-page-limit'
import { claudeContentBlocks, toolResultOutput } from './transcript-record-blocks'
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
  tool_call_id: string | null
  timestamp: number
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

function decodeRow(row: HermesMessageRow): NativeChatMessage | null {
  let blocks: NativeChatBlock[]
  if (row.role === 'tool') {
    blocks = [
      {
        type: 'tool-result',
        output: toolResultOutput(hermesContent(row.content)),
        ...(row.tool_call_id ? { callId: row.tool_call_id } : {})
      }
    ]
  } else if (row.role === 'assistant' || row.role === 'user') {
    blocks = [
      ...claudeContentBlocks(hermesContent(row.content)),
      ...(row.role === 'assistant' ? toolCalls(row.tool_calls) : [])
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
    const rows = rowsOf<HermesMessageRow>(
      db.prepare(
        `SELECT id, role, content, tool_calls, tool_call_id, timestamp FROM messages WHERE session_id = ?${visibleRows(db)} AND role IN ('user','assistant','tool') AND id < ? ORDER BY id DESC LIMIT ?`
      ),
      args.sessionId,
      args.beforeMessageRowId ?? Number.MAX_SAFE_INTEGER,
      limit + 1
    )
    const hasMore = rows.length > limit
    const selected = rows.slice(0, limit).toReversed()
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
