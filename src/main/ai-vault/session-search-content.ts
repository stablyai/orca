import { redactSessionSearchText } from '../ai-vault-search/session-search-redaction'
import {
  captureSessionSearchMessage,
  isSessionSearchCaptureActive,
  type SessionSearchCapturedRole
} from './session-search-capture'
import { timestampMs } from './session-scanner-values'

// Why: literal accuracy tracks this cap almost linearly (MRR 0.36 → 0.62 from
// none to 3 KB) while latency and disk scale the other way; 3 KB is the knee.
export const SESSION_SEARCH_TOOL_OUTPUT_CAP = 3000
// Sanity bound on a single conversational message.
const SESSION_SEARCH_TEXT_CAP = 200_000
const TOOL_INPUT_CAP = 2000

const HIDDEN_BLOCK_PATTERN =
  /<(system-reminder|codex_internal_context|goal_context)\b[^>]*>[\s\S]*?<\/\1>/gi
const TEXT_BLOCK_TYPES = new Set(['text', 'input_text', 'output_text', 'thinking', 'reasoning'])
const TOOL_INPUT_KEYS = ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'description']

type PreviewRole = 'user' | 'assistant' | 'system' | 'tool' | 'unknown'

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stripHiddenBlocks(text: string): string {
  return text.includes('<') ? text.replace(HIDDEN_BLOCK_PATTERN, ' ') : text
}

function cap(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text
}

function indexRole(role: PreviewRole): SessionSearchCapturedRole | null {
  return role === 'user' || role === 'assistant' || role === 'tool' ? role : null
}

/** Flattens a tool_result body (string, or array of text blocks) to one string. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  const parts: string[] = []
  let length = 0
  for (const item of content) {
    const text = typeof item === 'string' ? item : record(item)?.text
    if (typeof text === 'string' && text) {
      parts.push(text)
      length += text.length
      if (length >= SESSION_SEARCH_TOOL_OUTPUT_CAP) {
        break
      }
    }
  }
  return parts.join('\n')
}

export function toolCallText(name: unknown, input: unknown): string | null {
  const toolName = typeof name === 'string' && name ? name : null
  const inputRecord = record(input)
  let argument: string | null = null
  if (inputRecord) {
    for (const key of TOOL_INPUT_KEYS) {
      const value = inputRecord[key]
      if (typeof value === 'string' && value.trim()) {
        argument = value
        break
      }
    }
  } else if (typeof input === 'string' && input.trim()) {
    argument = input
  }
  if (!toolName && !argument) {
    return null
  }
  const bounded = argument ? cap(argument, TOOL_INPUT_CAP) : null
  return toolName && bounded ? `${toolName}: ${bounded}` : (toolName ?? bounded)
}

type IndexableMessage = { role: SessionSearchCapturedRole; text: string }

/**
 * Splits a provider content value into indexable messages. Text blocks keep
 * the record's role; tool_use and tool_result blocks become `tool` rows no
 * matter which record carried them (Claude stores tool results on user records).
 */
export function indexableMessagesFromContent(
  role: PreviewRole,
  content: unknown
): IndexableMessage[] {
  const out: IndexableMessage[] = []
  const textRole = indexRole(role)
  if (typeof content === 'string') {
    if (textRole) {
      out.push({ role: textRole, text: content })
    }
    return out
  }
  const blocks = Array.isArray(content) ? content : content != null ? [content] : []
  const textParts: string[] = []
  for (const block of blocks) {
    if (typeof block === 'string') {
      textParts.push(block)
      continue
    }
    const item = record(block)
    if (!item) {
      continue
    }
    const type = typeof item.type === 'string' ? item.type : null
    if (type === 'tool_use') {
      const text = toolCallText(item.name, item.input)
      if (text) {
        out.push({ role: 'tool', text })
      }
      continue
    }
    if (type === 'tool_result') {
      const text = toolResultText(item.content)
      if (text.trim()) {
        out.push({ role: 'tool', text })
      }
      continue
    }
    if (type !== null && !TEXT_BLOCK_TYPES.has(type)) {
      continue
    }
    const text = typeof item.text === 'string' ? item.text : item.content
    if (typeof text === 'string' && text) {
      textParts.push(text)
    }
  }
  if (textRole && textParts.length > 0) {
    out.unshift({ role: textRole, text: textParts.join('\n') })
  }
  return out
}

/** Emits index rows for a message when a capture scope is active; no-op otherwise. */
export function captureIndexableContent(
  role: PreviewRole,
  content: unknown,
  timestamp: unknown
): void {
  if (!isSessionSearchCaptureActive()) {
    return
  }
  for (const message of indexableMessagesFromContent(role, content)) {
    captureIndexableText(message.role, message.text, timestamp)
  }
}

export function captureIndexableText(
  role: PreviewRole,
  text: string | null,
  timestamp: unknown
): void {
  if (!text || !isSessionSearchCaptureActive()) {
    return
  }
  const indexed = indexRole(role)
  if (!indexed) {
    return
  }
  const limit = indexed === 'tool' ? SESSION_SEARCH_TOOL_OUTPUT_CAP : SESSION_SEARCH_TEXT_CAP
  // Redact before the final cap so a credential straddling it cannot survive in halves.
  const cleaned = cap(
    redactSessionSearchText(stripHiddenBlocks(cap(text, limit * 4))),
    limit
  ).trim()
  if (!cleaned) {
    return
  }
  const parsed = timestampMs(timestamp)
  captureSessionSearchMessage({
    role: indexed,
    text: cleaned,
    timestamp: Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
  })
}
