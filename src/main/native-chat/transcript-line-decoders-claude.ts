// Claude JSONL line → NativeChatMessage decoder.

import {
  NATIVE_CHAT_INTERRUPTED_STATUS_TEXT,
  type NativeChatBlock,
  type NativeChatMessage,
  type NativeChatNoticeLevel
} from '../../shared/native-chat-types'
import {
  asRecord,
  extractString,
  parseJsonObject,
  timestampMs
} from '../ai-vault/session-scanner-values'
import { claudeContentBlocks } from './transcript-record-blocks'
import { claudeInterruptedMessageId } from './transcript-turn-markers'

export function decodeClaudeTranscriptLine(
  line: string,
  fallbackId: string
): NativeChatMessage | null {
  const record = parseJsonObject(line)
  if (!record) {
    return null
  }
  const role = record.type
  if (role === 'system') {
    return decodeClaudeSystemNotice(record, fallbackId)
  }
  if (role !== 'user' && role !== 'assistant') {
    return null
  }
  const timestamp = parseTimestamp(record.timestamp)
  const recordMessageId = extractString(record.uuid) ?? fallbackId
  if (claudeInterruptedMessageId(record)) {
    // Why: keep Claude's injected boilerplate out of the user-bubble path while
    // preserving the interruption as a quiet, replayable conversation status.
    return {
      id: recordMessageId,
      role: 'system',
      blocks: [{ type: 'text', text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT }],
      timestamp,
      source: 'transcript'
    }
  }
  const message = asRecord(record.message)
  const decodedBlocks = claudeContentBlocks(message?.content)
  if (decodedBlocks.length === 0) {
    return null
  }
  // Why: Claude structurally marks injected turns, but tool-result records are
  // genuine output and must remain visible even when the containing turn is meta.
  const isInjectedUserTurn =
    role === 'user' &&
    (record.isMeta === true || record.isSynthetic === true || record.isCompactSummary === true)
  const blocks = isInjectedUserTurn
    ? decodedBlocks.filter((block) => block.type === 'tool-result')
    : decodedBlocks
  if (blocks.length === 0) {
    return null
  }
  const messageId = extractString(record.uuid) ?? extractString(message?.id)
  return {
    id: messageId ?? fallbackId,
    role: claudeMessageRole(role, blocks),
    blocks,
    timestamp,
    source: 'transcript'
  }
}

// Claude marks reasoning via `thinking` content blocks; when a message is made
// up solely of reasoning, surface it as a reasoning-role message.
function claudeMessageRole(
  role: 'user' | 'assistant',
  blocks: NativeChatBlock[]
): NativeChatMessage['role'] {
  if (role === 'user') {
    const onlyToolResults = blocks.every((block) => block.type === 'tool-result')
    return onlyToolResults && blocks.length > 0 ? 'tool' : 'user'
  }
  return role
}

function parseTimestamp(value: unknown): number | null {
  const parsed = timestampMs(value)
  return Number.isFinite(parsed) ? parsed : null
}

const CLAUDE_SYSTEM_NOISE_SUBTYPES = new Set([
  'stop_hook_summary',
  'turn_duration',
  'away_summary',
  'local_command',
  'hook_callback',
  'init',
  'compact_boundary'
])

const CLAUDE_API_RETRY_SOURCES = new Set(['request_retry', 'connection_retry'])

function decodeClaudeSystemNotice(
  record: Record<string, unknown>,
  fallbackId: string
): NativeChatMessage | null {
  const subtype = extractString(record.subtype)
  if (!subtype || CLAUDE_SYSTEM_NOISE_SUBTYPES.has(subtype)) {
    return null
  }
  if (subtype === 'api_error' && CLAUDE_API_RETRY_SOURCES.has(extractString(record.source) ?? '')) {
    return null
  }
  const error = asRecord(record.error)
  const text =
    extractString(record.content) ??
    extractString(record.error) ??
    extractString(error?.formatted) ??
    extractString(error?.message)
  if (!text) {
    return null
  }
  return {
    id: extractString(record.uuid) ?? fallbackId,
    role: 'system',
    blocks: [{ type: 'text', text }],
    timestamp: parseTimestamp(record.timestamp),
    source: 'transcript',
    notice: { level: claudeSystemNoticeLevel(record.level) }
  }
}

function claudeSystemNoticeLevel(value: unknown): NativeChatNoticeLevel {
  return value === 'warning' || value === 'error' ? value : 'info'
}
