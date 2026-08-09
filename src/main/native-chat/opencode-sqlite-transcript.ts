// OpenCode 1.18.x native-chat transcript reader.
//
// Why: OpenCode migrated conversations from per-session JSON files to a single
// SQLite DB at ~/.local/share/opencode/opencode.db (the same schema the AI Vault
// scanner reads). Unlike the JSONL agents, there is no append-only file to tail:
// the `part` rows mutate in place while the assistant streams, so a message's
// blocks are rebuilt from its current parts on every read. This module maps
// `message` + `part` rows to NativeChatMessages and pages the conversation by a
// stable ordinal window (read query-only, schema-guarded, malformed-tolerant).

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type {
  NativeChatBlock,
  NativeChatMessage,
  NativeChatRole
} from '../../shared/native-chat-types'
import { resolveOpenCodeDataDirectory } from '../opencode/opencode-data-directory'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'
import SyncDatabase from '../sqlite/sync-database'
import { asRecord, extractString, parseJsonObject } from '../ai-vault/session-scanner-values'
import { toolResultOutput } from './transcript-record-blocks'
import {
  readMappedOpenCodeTail,
  type OpenCodeMessageRow,
  type OpenCodePartRow
} from './opencode-sqlite-paging'

// Why: a heavy OpenCode session holds ~10K parts with multi-hundred-KB tool
// blobs (25-150 KB is common). Text/reasoning are the visible message body and
// stream part-by-part, so a generous cap keeps a pathological single part from
// freezing the message list; tool output is only previewed by the renderer.
const OPENCODE_TEXT_CHAR_CAP = 64_000
const OPENCODE_REASONING_CHAR_CAP = 32_000
const OPENCODE_TOOL_OUTPUT_CHAR_CAP = 100_000

export function resolveOpenCodeNativeChatDbPath(openCodeDbPath?: string): string {
  return openCodeDbPath ?? join(resolveOpenCodeDataDirectory(), 'opencode.db')
}

function openReadonlyDatabase(dbPath: string): SyncDatabase {
  const db = new SyncDatabase(dbPath, { readonly: true, fileMustExist: true })
  db.pragma('query_only = ON')
  return db
}

/** Schema guards mirroring session-scanner-opencode-sqlite.ts: require the
 *  tables and columns the chat read actually touches, and bail out cleanly on
 *  older generations rather than throwing. */
export function canReadOpenCodeChatSession(db: SyncDatabase): boolean {
  return (
    tableExists(db, 'session') &&
    tableExists(db, 'message') &&
    tableExists(db, 'part') &&
    columnExists(db, 'message', 'id') &&
    columnExists(db, 'message', 'session_id') &&
    columnExists(db, 'message', 'time_created') &&
    columnExists(db, 'message', 'data') &&
    columnExists(db, 'part', 'message_id') &&
    columnExists(db, 'part', 'time_created') &&
    columnExists(db, 'part', 'data')
  )
}

function openCodeSessionRowExists(db: SyncDatabase, sessionId: string): boolean {
  const row = db.prepare('SELECT 1 AS found FROM session WHERE id = ? LIMIT 1').get(sessionId) as
    | { found?: number }
    | undefined
  return row?.found === 1
}

function countSessionMessages(db: SyncDatabase, sessionId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM message m WHERE m.session_id = ?')
    .get(sessionId) as { n?: number } | undefined
  return typeof row?.n === 'number' ? row.n : 0
}

export function clipOpenCodeText(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}\n… (truncated)` : text
}

/** Build the tool-call + tool-result blocks for one OpenCode `tool` part. The
 *  part mutates in place (pending → running → completed/error), so the message
 *  id stays stable and the live reconcile re-emits the same message with the
 *  finished blocks; the renderer's id-dedup replaces the old copy. */
function openCodeToolBlocks(record: Record<string, unknown>): NativeChatBlock[] {
  const state = asRecord(record.state)
  const name = extractString(record.tool) ?? 'tool'
  const input = state?.input
  const status = extractString(state?.status)
  const toolCall: NativeChatBlock = { type: 'tool-call', name, input }
  if (status === 'completed') {
    return [
      toolCall,
      {
        type: 'tool-result',
        output: clipOpenCodeText(toolResultOutput(state?.output), OPENCODE_TOOL_OUTPUT_CHAR_CAP)
      }
    ]
  }
  if (status === 'error') {
    const errorText = extractString(state?.error) ?? toolResultOutput(state?.output)
    return [
      toolCall,
      {
        type: 'tool-result',
        output: clipOpenCodeText(errorText, OPENCODE_TOOL_OUTPUT_CHAR_CAP),
        isError: true
      }
    ]
  }
  // pending / running / unknown: the call is in flight, no result yet.
  return [toolCall]
}

/** Map the current parts of one OpenCode message into NativeChat blocks.
 *  Returns `{ blocks, reasoningText, reasonOnly }` so the caller can decide
 *  whether to surface a reasoning-only message. */
function openCodePartBlocks(partData: string | null): {
  blocks: NativeChatBlock[]
  reasoningText: string[]
} {
  const blocks: NativeChatBlock[] = []
  const reasoningText: string[] = []
  const record = parseJsonObject(partData ?? '')
  if (!record) {
    return { blocks, reasoningText }
  }
  const type = extractString(record.type)
  if (type === 'text') {
    const text = extractString(record.text)
    if (text) {
      blocks.push({ type: 'text', text: clipOpenCodeText(text, OPENCODE_TEXT_CHAR_CAP) })
    }
  } else if (type === 'reasoning') {
    const text = extractString(record.text)
    if (text) {
      reasoningText.push(clipOpenCodeText(text, OPENCODE_REASONING_CHAR_CAP))
    }
  } else if (type === 'tool') {
    blocks.push(...openCodeToolBlocks(record))
  } else if (type === 'patch') {
    // Why: a `patch` part records applied file edits; surface it as tool
    // activity so the conversation shows what changed without shipping the diff.
    const files = Array.isArray(record.files)
      ? record.files.filter((f) => typeof f === 'string')
      : []
    blocks.push({ type: 'tool-call', name: 'patch', input: { hash: record.hash ?? null, files } })
  }
  // Everything else (step-start/step-finish, snapshot, compaction, agent, …)
  // is lifecycle noise and intentionally dropped.
  return { blocks, reasoningText }
}

/** Map one SQLite message row (with its parts) to a NativeChatMessage, or null
 *  when the row is not a conversational turn (unknown role, no mapable parts,
 *  malformed JSON — all tolerated, never thrown). */
export function mapOpenCodeNativeChatMessage(
  message: OpenCodeMessageRow,
  parts: OpenCodePartRow[]
): NativeChatMessage | null {
  const dataRecord = parseJsonObject(message.data ?? '')
  const role = extractString(dataRecord?.role)
  if (role !== 'user' && role !== 'assistant') {
    return null
  }
  const timestamp =
    typeof message.time_created === 'number' &&
    Number.isFinite(message.time_created) &&
    message.time_created > 0
      ? message.time_created
      : null

  const blocks: NativeChatBlock[] = []
  const reasoningText: string[] = []
  for (const part of parts) {
    const mapped = openCodePartBlocks(part.data)
    blocks.push(...mapped.blocks)
    reasoningText.push(...mapped.reasoningText)
  }

  if (blocks.length === 0) {
    if (reasoningText.length === 0) {
      return null
    }
    // Why: a message holding only reasoning reads as a thinking bubble, matching
    // the Codex decoder's reasoning-role handling.
    return {
      id: message.id,
      role: 'reasoning',
      blocks: [{ type: 'text', text: reasoningText.join('\n') }],
      timestamp,
      source: 'transcript'
    }
  }

  const messageRole: NativeChatRole = role === 'assistant' ? 'assistant' : 'user'
  return {
    id: message.id,
    role: messageRole,
    blocks,
    timestamp,
    source: 'transcript'
  }
}

/** Stable content signature for one message; the live reconcile compares it to
 *  detect in-place part mutations (streaming text/tool state) under a stable id. */
export function openCodeMessageSignature(message: NativeChatMessage): string {
  return JSON.stringify([message.role, message.timestamp, message.blocks])
}

/** Resolve a session row's conversation window. `beforeOffset` is the ascending
 *  ordinal of the OLDEST row in the previously returned page; the reader returns
 *  the `limit` rows strictly before it. Undefined reads the newest tail. */
export async function readOpenCodeNativeChatTranscriptTail(args: {
  dbPath: string
  sessionId: string
  limit: number
  beforeOffset?: number
}): Promise<
  | {
      messages: NativeChatMessage[]
      hasMore: boolean
      beforeOffset: number
    }
  | { error: string; notFound?: true }
> {
  const { dbPath, sessionId } = args
  const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 40
  let db: SyncDatabase | null = null
  try {
    // Why: SyncDatabase's fileMustExist guard throws a plain Error (no ENOENT
    // code), so the miss must be detected before opening: a just-launched
    // OpenCode session can legitimately not have a DB file yet, and that miss
    // is retry-worthy like a JSONL first-flush.
    if (!existsSync(dbPath)) {
      return { error: `SQLite database does not exist: ${dbPath}`, notFound: true }
    }
    db = openReadonlyDatabase(dbPath)
    if (!canReadOpenCodeChatSession(db)) {
      return { error: 'Transcript unavailable' }
    }
    if (!openCodeSessionRowExists(db, sessionId)) {
      // Why: a brand-new session can report its id before OpenCode flushes the
      // first message; keep this retry-worthy like a JSONL first-flush miss.
      return { error: 'Transcript unavailable', notFound: true }
    }
    const count = countSessionMessages(db, sessionId)
    const windowEnd = Math.max(
      0,
      Math.min(args.beforeOffset === undefined ? count : args.beforeOffset, count)
    )
    if (windowEnd <= 0) {
      return { messages: [], hasMore: false, beforeOffset: 0 }
    }
    return readMappedOpenCodeTail({
      db,
      sessionId,
      windowEnd,
      limit,
      mapMessage: mapOpenCodeNativeChatMessage
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
      ? { error: message, notFound: true }
      : { error: message }
  } finally {
    db?.close()
  }
}
