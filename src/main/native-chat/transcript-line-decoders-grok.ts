import type { NativeChatBlock, NativeChatMessage } from '../../shared/native-chat/native-chat-types'
import {
  asRecord,
  extractString,
  parseJsonObject,
  timestampMs
} from '../ai-vault/session-scanner-values'
import { claudeContentBlocksWork, toolResultOutputWork } from './transcript-record-blocks'
import { finishTranscriptWork, type TranscriptWork } from './transcript-work-scheduler'
import { parseTranscriptValueWork } from './transcript-record-parser'
import { AGENT_SESSION_PASTED_IMAGE_SUFFIX_SOURCE } from '../../shared/agent-session/agent-session-attachments'

export function decodeGrokTranscriptLine(
  line: string,
  fallbackId: string
): NativeChatMessage | null {
  return decodeGrokTranscriptRecord(parseJsonObject(line), fallbackId)
}

export function decodeGrokTranscriptRecord(
  record: Record<string, unknown> | null,
  fallbackId: string
): NativeChatMessage | null {
  return finishTranscriptWork(
    decodeGrokTranscriptRecordWork(record, fallbackId, function* (text) {
      yield 1
      const value: unknown = JSON.parse(text)
      return value
    })
  )
}

export function* decodeGrokTranscriptRecordWork(
  record: Record<string, unknown> | null,
  fallbackId: string,
  parseValue: (text: string) => TranscriptWork<unknown> = parseTranscriptValueWork
): TranscriptWork<NativeChatMessage | null> {
  if (!record) {
    return null
  }
  const type = extractString(record.type)
  if (!type) {
    return null
  }
  const timestamp = parseTimestamp(record.timestamp)
  const recordId = extractString(record.id)
  // Position-prefix every ID: missing timestamps and IDs otherwise lose transcript order.
  const id = recordId ? `${fallbackId}:${recordId}` : fallbackId

  if (type === 'user' || type === 'assistant') {
    // Bootstrap context also uses user rows; only actual prompts belong in the timeline.
    if (
      type === 'user' &&
      (hasNonEmptySyntheticReason(record) || isGrokBootstrapContext(record.content))
    ) {
      return null
    }
    const rawBlocks = yield* claudeContentBlocksWork(record.content)
    const blocks = type === 'user' ? yield* normalizeGrokUserQueryBlocks(rawBlocks) : rawBlocks
    if (blocks.length === 0) {
      const toolBlocks = yield* grokToolCallBlocks(record.tool_calls, parseValue)
      if (toolBlocks.length === 0) {
        return null
      }
      return { id, role: 'assistant', blocks: toolBlocks, timestamp, source: 'transcript' }
    }
    if (type === 'assistant') {
      const toolBlocks = yield* grokToolCallBlocks(record.tool_calls, parseValue)
      for (const block of toolBlocks) {
        yield 1
        blocks.push(block)
      }
      return {
        id,
        role: 'assistant',
        blocks,
        timestamp,
        source: 'transcript'
      }
    }
    return { id, role: 'user', blocks, timestamp, source: 'transcript' }
  }

  if (type === 'reasoning') {
    const text =
      extractString(record.text) ??
      (yield* grokSummaryText(record.summary)) ??
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
    const output = yield* toolResultOutputWork(record.content ?? record.output ?? record.result)
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

function* grokToolCallBlocks(
  value: unknown,
  parseValue: (text: string) => TranscriptWork<unknown>
): TranscriptWork<NativeChatBlock[]> {
  if (!Array.isArray(value)) {
    return []
  }
  const blocks: NativeChatBlock[] = []
  for (const item of value) {
    yield 1
    const record = asRecord(item)
    if (!record) {
      continue
    }
    const name = extractString(record.name) ?? extractString(record.tool) ?? 'tool'
    let input: unknown = record.arguments ?? record.input ?? record.args
    if (typeof input === 'string') {
      try {
        input = yield* parseValue(input)
      } catch (error) {
        if (!(error instanceof SyntaxError)) {
          throw error
        }
        // Preserve unparseable arguments as text.
      }
    }
    blocks.push({ type: 'tool-call', name, input })
  }
  return blocks
}

function* grokSummaryText(value: unknown): TranscriptWork<string | null> {
  if (typeof value === 'string') {
    return value
  }
  if (!Array.isArray(value)) {
    return null
  }
  const parts: string[] = []
  for (const item of value) {
    yield 1
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
  // Strip only known bootstrap envelopes; genuine prompts may mention the same tags.
  let remainder = normalized.slice(userInfoEnd + '</user_info>'.length).trim()
  while (remainder.length > 0) {
    const section = GROK_BOOTSTRAP_SECTIONS.find((name) => remainder.startsWith(`<${name}>`))
    const sectionEnd = section ? remainder.indexOf(`</${section}>`) : -1
    if (!section || sectionEnd === -1) {
      return false
    }
    remainder = remainder.slice(sectionEnd + `</${section}>`.length).trim()
  }
  return true
}

const GROK_BOOTSTRAP_SECTIONS = ['git_status', 'rules']

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

const GROK_PASTED_IMAGE_QUERY = new RegExp(
  String.raw`^((?:[a-z]:[\\/]|\/|[\\/]{2}[^\\/\r\n]+[\\/][^\\/\r\n]+[\\/])(?:.*?[\\/])?orca-paste-[^\\/\r\n]+?` +
    AGENT_SESSION_PASTED_IMAGE_SUFFIX_SOURCE +
    String.raw`)([\s\S]*)$`,
  'i'
)

function splitGrokPastedImageQuery(text: string): { path: string; query: string } | null {
  // Grok 0.2.93 concatenates clipboard temp paths with prompts; recover the attachment separately.
  const match = text.match(GROK_PASTED_IMAGE_QUERY)
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

function* normalizeGrokUserQueryBlocks(
  blocks: NativeChatBlock[]
): TranscriptWork<NativeChatBlock[]> {
  const normalized: NativeChatBlock[] = []
  for (const block of blocks) {
    yield 1
    for (const part of normalizeGrokUserQueryBlock(block)) {
      normalized.push(part)
    }
  }
  return normalized
}
