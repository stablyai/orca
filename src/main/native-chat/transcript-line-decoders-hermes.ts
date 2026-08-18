import type {
  NativeChatBlock,
  NativeChatMessage,
  NativeChatRole
} from '../../shared/native-chat-types'
import {
  asRecord,
  extractString,
  parseJsonObject,
  timestampMs
} from '../ai-vault/session-scanner-values'

const ROLES = new Set<NativeChatRole>(['user', 'assistant', 'tool', 'reasoning', 'system'])

type HermesMessageRecord = {
  id?: unknown
  role?: unknown
  content?: unknown
  parts?: unknown
  timestamp?: unknown
  tool_calls?: unknown
  tool_call_id?: unknown
  tool_name?: unknown
  reasoning?: unknown
  reasoning_content?: unknown
  reasoning_details?: unknown
}

type HermesToolCall = {
  id?: unknown
  call_id?: unknown
  name?: unknown
  arguments?: unknown
  function?: unknown
}

function asHermesMessageRecord(value: unknown): HermesMessageRecord | null {
  return asRecord(value) as HermesMessageRecord | null
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value
  }
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

function textBlock(text: string): NativeChatBlock {
  return { type: 'text', text }
}

function toolCallBlock(call: HermesToolCall): NativeChatBlock {
  const fn = asRecord(call.function)
  const name = extractString(call.name) ?? extractString(fn?.name) ?? 'tool'
  const input = parseJsonValue(call.arguments ?? call.input ?? fn?.arguments) ?? {}
  return {
    type: 'tool-call',
    name,
    input
  }
}

function decodeStoredToolCalls(value: unknown): NativeChatBlock[] {
  const parsed = parseJsonValue(value)
  if (!Array.isArray(parsed)) {
    return []
  }
  return parsed
    .map((item) => {
      const call = asHermesMessageRecord(item) as HermesToolCall | null
      return call ? toolCallBlock(call) : null
    })
    .filter((block): block is NativeChatBlock => block !== null)
}

function decodeFlatToolCall(message: HermesMessageRecord): NativeChatBlock[] {
  if (extractString(message.tool_name) === null || extractString(message.tool_call_id) !== null) {
    return []
  }
  const calls = parseJsonValue(message.tool_calls)
  if (Array.isArray(calls)) {
    return []
  }
  return [
    {
      type: 'tool-call',
      name: extractString(message.tool_name) ?? 'tool',
      input: calls ?? {}
    }
  ]
}

function decodeStoredReasoning(message: HermesMessageRecord): NativeChatBlock[] {
  const reasoning =
    extractString(message.reasoning) ??
    extractString(message.reasoning_content) ??
    extractString(message.reasoning_details)
  return reasoning ? [textBlock(reasoning)] : []
}

function decodeStoredToolResult(message: HermesMessageRecord): NativeChatBlock[] {
  if (extractString(message.tool_call_id) === null) {
    return []
  }
  return [
    {
      type: 'tool-result',
      output: stringifyToolOutput(message.content)
    }
  ]
}

function decodeHermesMessageBlocks(message: HermesMessageRecord): NativeChatBlock[] {
  return [
    ...decodeBlocks(message.content ?? message.parts),
    ...decodeStoredToolCalls(message.tool_calls),
    ...decodeFlatToolCall(message),
    ...decodeStoredReasoning(message),
    ...decodeStoredToolResult(message)
  ]
}

function normalizeHermesMessageRecord(record: Record<string, unknown>): HermesMessageRecord {
  return asHermesMessageRecord(record.message) ?? record
}

function getHermesMessageTimestamp(
  record: Record<string, unknown>,
  message: HermesMessageRecord
): unknown {
  return record.timestamp ?? message.timestamp
}

function getHermesMessageId(
  record: Record<string, unknown>,
  message: HermesMessageRecord,
  fallbackId: string
): string {
  return extractString(record.id) ?? extractString(message.id) ?? fallbackId
}

function decodeHermesRecord(
  record: Record<string, unknown>,
  fallbackId: string
): NativeChatMessage | null {
  const message = normalizeHermesMessageRecord(record)
  const role = normalizeRole(extractString(message.role))
  if (!role || !ROLES.has(role as NativeChatRole)) {
    return null
  }
  const blocks = decodeHermesMessageBlocks(message)
  if (blocks.length === 0) {
    return null
  }
  return {
    id: getHermesMessageId(record, message, fallbackId),
    role: role as NativeChatRole,
    blocks,
    timestamp: timestampMs(getHermesMessageTimestamp(record, message)),
    source: 'transcript'
  }
}

function decodeBlocks(value: unknown): NativeChatBlock[] {
  if (typeof value === 'string' && value.length > 0) {
    return [textBlock(value)]
  }
  if (!Array.isArray(value)) {
    return []
  }
  const blocks: NativeChatBlock[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0) {
      blocks.push(textBlock(item))
      {
        continue
      }
    }
    const block = asRecord(item)
    if (!block) {
      continue
    }
    const type = extractString(block.type)
    if (type === 'text' && typeof block.text === 'string') {
      blocks.push(textBlock(block.text))
    } else if (type === 'thinking' && typeof block.thinking === 'string') {
      blocks.push(textBlock(block.thinking))
    } else if (type === 'tool-call') {
      blocks.push(toolCallBlock(block as HermesToolCall))
    } else if (type === 'tool-result') {
      blocks.push({
        type: 'tool-result',
        output: stringifyToolOutput(block.output ?? block.content),
        ...(block.isError === true ? { isError: true } : {})
      })
    }
  }
  return blocks
}

/**
 * Decodes the JSONL message envelope emitted by Hermes session exports.
 * Unknown records and future event types are deliberately ignored: the
 * session store is the source of truth, while operational events are not
 * conversation messages and should not become fabricated transcript rows.
 */
export function decodeHermesTranscriptLine(
  line: string,
  fallbackId: string
): NativeChatMessage | null {
  const record = parseJsonObject(line)
  if (!record) {
    return null
  }
  return decodeHermesRecord(record, fallbackId)
}

export function decodeHermesDatabaseMessage(
  row: Record<string, unknown>,
  fallbackId: string
): NativeChatMessage | null {
  const role = normalizeRole(extractString(row.role))
  if (!role || !ROLES.has(role as NativeChatRole)) {
    return null
  }
  const blocks = [
    ...(role === 'tool' ? [] : decodeBlocks(row.content)),
    ...decodeStoredToolCalls(row.tool_calls),
    ...decodeFlatToolCall(row as HermesMessageRecord),
    ...decodeStoredReasoning(row),
    ...decodeStoredToolResult(row)
  ]
  if (blocks.length === 0) {
    return null
  }
  return {
    id: typeof row.id === 'number' || typeof row.id === 'string' ? String(row.id) : fallbackId,
    role: role as NativeChatRole,
    blocks,
    timestamp: timestampMs(row.timestamp),
    source: 'transcript'
  }
}

function normalizeRole(role: string | null): string | null {
  if (!role) {
    return null
  }
  if (role === 'model') {
    return 'assistant'
  }
  if (role === 'human') {
    return 'user'
  }
  return role
}

function stringifyToolOutput(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (value == null) {
    return ''
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
