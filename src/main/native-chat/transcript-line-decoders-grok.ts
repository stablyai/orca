// Grok chat_history.jsonl line → NativeChatMessage decoder.

import type { NativeChatBlock, NativeChatMessage } from '../../shared/native-chat-types'
import {
  asRecord,
  extractString,
  parseJsonObject,
  timestampMs
} from '../ai-vault/session-scanner-values'
import { claudeContentBlocks, toolResultOutput } from './transcript-record-blocks'

/**
 * Grok `chat_history.jsonl` rows: user/assistant/reasoning/tool records with
 * Claude-like content blocks plus Grok-specific `backend_tool_call` /
 * `tool_result` shapes. System prompts are skipped.
 */
export function decodeGrokTranscriptLine(
  line: string,
  fallbackId: string
): NativeChatMessage | null {
  const record = parseJsonObject(line)
  if (!record) {
    return null
  }
  const type = extractString(record.type)
  if (!type) {
    return null
  }
  const timestamp = parseTimestamp(record.timestamp)
  const recordId = extractString(record.id)
  // Why: Grok rows frequently omit timestamps and only some carry ids; prefix
  // every row with its JSONL position so Native Chat preserves transcript order.
  const id = recordId ? `${fallbackId}:${recordId}` : fallbackId

  if (type === 'user' || type === 'assistant') {
    // Why: Grok records bootstrap context as user rows; only submitted prompts
    // belong in the conversation shown to the user.
    if (
      type === 'user' &&
      (hasNonEmptySyntheticReason(record) || isGrokBootstrapContext(record.content))
    ) {
      return null
    }
    const rawBlocks = claudeContentBlocks(record.content)
    const blocks = type === 'user' ? rawBlocks.flatMap(normalizeGrokUserQueryBlock) : rawBlocks
    if (blocks.length === 0) {
      // Empty assistant rows often only hold tool_calls — surface those.
      const toolBlocks = grokToolCallBlocks(record.tool_calls)
      if (toolBlocks.length === 0) {
        return null
      }
      return { id, role: 'assistant', blocks: toolBlocks, timestamp, source: 'transcript' }
    }
    if (type === 'assistant') {
      const toolBlocks = grokToolCallBlocks(record.tool_calls)
      return {
        id,
        role: 'assistant',
        blocks: [...blocks, ...toolBlocks],
        timestamp,
        source: 'transcript'
      }
    }
    return { id, role: 'user', blocks, timestamp, source: 'transcript' }
  }

  if (type === 'reasoning') {
    const text =
      extractString(record.text) ??
      grokSummaryText(record.summary) ??
      extractString(asRecord(record.content)?.text)
    if (!text?.trim()) {
      return null
    }
    return {
      id,
      role: 'reasoning',
      blocks: [{ type: 'text', text }],
      timestamp,
      source: 'transcript'
    }
  }

  if (type === 'backend_tool_call' || type === 'tool_call') {
    const name =
      extractString(asRecord(record.kind)?.tool_type) ??
      extractString(record.name) ??
      extractString(record.tool) ??
      'tool'
    return {
      id,
      role: 'assistant',
      blocks: [{ type: 'tool-call', name, input: record.kind ?? record.arguments ?? record.input }],
      timestamp,
      source: 'transcript'
    }
  }

  if (type === 'tool_result') {
    const output = toolResultOutput(record.content ?? record.output ?? record.result)
    return {
      id,
      role: 'tool',
      blocks: [
        {
          type: 'tool-result',
          output,
          ...(record.is_error === true || record.isError === true ? { isError: true } : {})
        }
      ],
      timestamp,
      source: 'transcript'
    }
  }

  return null
}

function grokToolCallBlocks(value: unknown): NativeChatBlock[] {
  if (!Array.isArray(value)) {
    return []
  }
  const blocks: NativeChatBlock[] = []
  for (const item of value) {
    const record = asRecord(item)
    if (!record) {
      continue
    }
    const name = extractString(record.name) ?? extractString(record.tool) ?? 'tool'
    let input: unknown = record.arguments ?? record.input ?? record.args
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input)
      } catch {
        // keep string
      }
    }
    blocks.push({ type: 'tool-call', name, input })
  }
  return blocks
}

function grokSummaryText(value: unknown): string | null {
  if (typeof value === 'string') {
    return value
  }
  if (!Array.isArray(value)) {
    return null
  }
  const parts: string[] = []
  for (const item of value) {
    const record = asRecord(item)
    const text = extractString(record?.text) ?? extractString(record?.summary_text)
    if (text) {
      parts.push(text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : null
}

function hasNonEmptySyntheticReason(record: Record<string, unknown>): boolean {
  return typeof record.synthetic_reason === 'string' && record.synthetic_reason.trim().length > 0
}

function isGrokBootstrapContext(content: unknown): boolean {
  const text = standaloneTextContent(content)
  if (!text) {
    return false
  }
  const normalized = text.trim().toLowerCase()
  if (!normalized.startsWith('<user_info>')) {
    return false
  }
  const userInfoEnd = normalized.indexOf('</user_info>')
  if (userInfoEnd === -1) {
    return false
  }
  const remainder = normalized.slice(userInfoEnd + '</user_info>'.length).trim()
  // Why: Grok 0.2.93 appends its git snapshot to the user-info bootstrap row;
  // reject only that known envelope so real prompts mentioning either tag survive.
  return (
    remainder.length === 0 ||
    (remainder.startsWith('<git_status>') && remainder.endsWith('</git_status>'))
  )
}

function standaloneTextContent(content: unknown): string | null {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content) || content.length !== 1) {
    return null
  }
  const block = asRecord(content[0])
  return block?.type === 'text' ? (extractString(block.text) ?? null) : null
}

function normalizeGrokUserQueryBlock(block: NativeChatBlock): NativeChatBlock[] {
  if (block.type !== 'text') {
    return [block]
  }
  const stripped = stripGrokUserQueryEnvelope(block.text)
  if (!stripped.trim()) {
    return []
  }
  const pastedImage = splitGrokPastedImageQuery(stripped)
  if (!pastedImage) {
    return [stripped === block.text ? block : { type: 'text', text: stripped }]
  }
  return [
    { type: 'image-ref', path: pastedImage.path },
    ...(pastedImage.query ? [{ type: 'text' as const, text: pastedImage.query }] : [])
  ]
}

function splitGrokPastedImageQuery(text: string): { path: string; query: string } | null {
  // Why: Grok 0.2.93 persists clipboard images as an absolute temp path directly
  // concatenated with the prompt; recover Orca's attachment without exposing it.
  const match = text.match(
    /^((?:[a-z]:[\\/]|\/|[\\/]{2}[^\\/\r\n]+[\\/][^\\/\r\n]+[\\/])(?:.*?[\\/])?orca-paste-[^\\/\r\n]+?\.png)([\s\S]*)$/i
  )
  if (!match?.[1]) {
    return null
  }
  return { path: match[1], query: (match[2] ?? '').trim() }
}

function stripGrokUserQueryEnvelope(text: string): string {
  const opener = '<user_query>'
  const closer = '</user_query>'
  const lower = text.toLowerCase()
  const start = lower.indexOf(opener)
  if (start === -1) {
    return text
  }
  const bodyStart = start + opener.length
  const end = lower.indexOf(closer, bodyStart)
  if (end === -1) {
    return text.slice(bodyStart).trim()
  }
  return text.slice(bodyStart, end).trim()
}

function parseTimestamp(value: unknown): number | null {
  const parsed = timestampMs(value)
  return Number.isFinite(parsed) ? parsed : null
}
