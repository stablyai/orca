// OpenCode native-chat transcript reader.
//
// OpenCode stores conversations in a host-owned SQLite database. The canonical
// live database is `opencode.db`; sibling database copies are fallbacks, and
// `OPENCODE_DB` can select another host-owned database. Unlike JSONL agents,
// `part` rows mutate in place while the assistant streams, so a message's
// blocks are rebuilt from current parts on every read. This module maps
// `message` + `part` rows to NativeChatMessages and pages by a stable ordinal
// window (read query-only, schema-guarded, malformed-tolerant).


import { statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type {
  NativeChatBlock,
  NativeChatMessage,
  NativeChatRole
} from '../../shared/native-chat-types'
import { resolveOpenCodeDataDirectory } from '../opencode/opencode-data-directory'
import { asRecord, extractString, parseJsonObject } from '../ai-vault/session-scanner-values'
import { toolResultOutput } from './transcript-record-blocks'
import { readOpenCodeNativeChatTranscript } from './opencode-sqlite-read'
import type { OpenCodeReadResult } from './opencode-sqlite-read'
import type { OpenCodeMessageRow, OpenCodePartRow } from './opencode-sqlite-paging'

export { canReadOpenCodeChatSession, isRetryableOpenCodeSqliteError } from './opencode-sqlite-read'

// Why: a heavy OpenCode session holds ~10K parts with multi-hundred-KB tool
// blobs (25-150 KB is common). Text/reasoning are the visible message body and
// stream part-by-part, so a generous cap keeps a pathological single part from
// freezing the message list; tool output is only previewed by the renderer.
const OPENCODE_TEXT_CHAR_CAP = 64_000
const OPENCODE_REASONING_CHAR_CAP = 32_000
const OPENCODE_TOOL_OUTPUT_CHAR_CAP = 100_000

const OPEN_CODE_DEFAULT_DATABASE_NAMES = [
  'opencode.db',
  'opencode-next.db',
  'opencode-local.db',
  'opencode-prod.db'
] as const

function resolveConfiguredDatabasePath(path: string): string | null {
  if (path === ':memory:') {
    return null
  }
  try {
    return statSync(path).isFile() ? path : null
  } catch {
    // A configured database may be created after the first live poll.
    return path
  }
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function resolveOpenCodeNativeChatDbPath(openCodeDbPath?: string): string | null {
  const explicitPath = openCodeDbPath?.trim()
  if (explicitPath) {
    return resolveConfiguredDatabasePath(explicitPath)
  }
  const dataDirectory = resolveOpenCodeDataDirectory()
  const configuredPath = process.env.OPENCODE_DB?.trim()
  if (configuredPath) {
    if (configuredPath === ':memory:') {
      return null
    }
    const resolvedPath = isAbsolute(configuredPath)
      ? configuredPath
      : join(dataDirectory, configuredPath)
    return resolveConfiguredDatabasePath(resolvedPath)
  }
  for (const databaseName of OPEN_CODE_DEFAULT_DATABASE_NAMES) {
    const candidate = join(dataDirectory, databaseName)
    if (isRegularFile(candidate)) {
      return candidate
    }
  }
  return join(dataDirectory, 'opencode.db')
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
  parts: OpenCodePartRow[],
  signal?: AbortSignal
): NativeChatMessage | null {
  signal?.throwIfAborted()
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
    signal?.throwIfAborted()
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
  dbPath: string | null
  sessionId: string
  limit: number
  beforeOffset?: number
  signal?: AbortSignal
}): Promise<OpenCodeReadResult> {
  args.signal?.throwIfAborted()
  return readOpenCodeNativeChatTranscript(args, mapOpenCodeNativeChatMessage)
}
