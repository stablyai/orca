import { fileURLToPath } from 'node:url'
import type { AgentSessionTokenUsage } from '../../shared/agent-session/agent-session-context-usage'
import { NATIVE_CHAT_NOTICE_COPY } from '../../shared/native-chat/native-chat-notice'
import {
  NATIVE_CHAT_INTERRUPTED_STATUS_TEXT,
  type NativeChatBlock,
  type NativeChatImageRefBlock,
  type NativeChatMessage
} from '../../shared/native-chat/native-chat-types'
import {
  asRecord,
  extractString,
  parseJsonObject,
  timestampMs
} from '../ai-vault/session-scanner-values'
import { toolResultOutput } from './transcript-record-blocks'

const USER_REQUEST_OPENER = '<USER_REQUEST>'
const USER_REQUEST_CLOSER = '</USER_REQUEST>'
const SYSTEM_MESSAGE_SUFFIX =
  /\n*The following is a <SYSTEM_MESSAGE> not actually sent by the user[\s\S]*$/

export function decodeAntigravityTranscriptLine(
  line: string,
  fallbackId: string
): NativeChatMessage | NativeChatMessage[] | null {
  const record = parseJsonObject(line)
  if (!record) {
    return null
  }
  const source = extractString(record.source)
  const type = extractString(record.type)
  const rawTs = timestampMs(record.created_at ?? record.timestamp)
  const timestamp = Number.isFinite(rawTs) ? rawTs : null
  const baseId = antigravityBaseRecordId(record, fallbackId)

  if (type === 'CHECKPOINT') {
    const rawContent = typeof record.content === 'string' ? record.content : ''
    return isAntigravityCompactionSummary(rawContent) ? compactionMessage(baseId, timestamp) : null
  }
  if (
    (source === 'USER_EXPLICIT' || source === 'USER' || source === 'SYSTEM' || source === null) &&
    (type === 'USER_INPUT' || type === 'REQUEST' || type === null)
  ) {
    return decodeAntigravityUserRecord(record, baseId, timestamp, source)
  }
  if ((source === 'MODEL' || source === null) && type === 'PLANNER_RESPONSE') {
    return decodeAntigravityPlannerRecord(record, baseId, timestamp, fallbackId)
  }
  if ((source === 'MODEL' || source === 'TOOL' || source === null) && type === 'GENERIC') {
    return decodeAntigravityToolResultRecord(record, baseId, timestamp)
  }
  return null
}

export function antigravityBaseRecordId(
  record: Record<string, unknown>,
  fallbackId: string
): string {
  const stepIndex = record.step_index
  if (typeof stepIndex === 'number' && Number.isSafeInteger(stepIndex) && stepIndex >= 0) {
    return `${fallbackId}:step-${stepIndex}`
  }
  const id = extractString(record.id) ?? extractString(record.uuid)
  return id ? `${fallbackId}:${id}` : fallbackId
}

function transcriptMsg(
  id: string,
  role: NativeChatMessage['role'],
  blocks: NativeChatBlock[],
  timestamp: number | null,
  extra?: Partial<Pick<NativeChatMessage, 'model' | 'usage'>>
): NativeChatMessage {
  return { id, role, blocks, timestamp, source: 'transcript', ...extra }
}

function compactionMessage(id: string, timestamp: number | null): NativeChatMessage {
  return transcriptMsg(
    id,
    'system',
    [{ type: 'text', text: NATIVE_CHAT_NOTICE_COPY.compaction, presentation: 'compaction' }],
    timestamp
  )
}

function decodeAntigravityUserRecord(
  record: Record<string, unknown>,
  id: string,
  timestamp: number | null,
  source: string | null
): NativeChatMessage | null {
  const rawContent = typeof record.content === 'string' ? record.content : ''
  if (isAntigravityCompactionSummary(rawContent)) {
    return compactionMessage(id, timestamp)
  }
  const text = source === 'SYSTEM' ? null : unwrapAntigravityUserText(rawContent)
  const blocks: NativeChatBlock[] =
    source === 'SYSTEM'
      ? []
      : [
          ...antigravityMediaBlocks(record.media),
          ...(text ? [{ type: 'text' as const, text }] : [])
        ]
  return blocks.length > 0 ? transcriptMsg(id, 'user', blocks, timestamp) : null
}

function decodeAntigravityPlannerRecord(
  record: Record<string, unknown>,
  baseId: string,
  timestamp: number | null,
  fallbackId: string
): NativeChatMessage | NativeChatMessage[] | null {
  const thinking = extractString(record.thinking)
  const rawContent =
    typeof record.content === 'string' ? record.content.replace(SYSTEM_MESSAGE_SUFFIX, '') : ''
  const blocks: NativeChatBlock[] = [
    ...(rawContent.trim() ? [{ type: 'text' as const, text: rawContent }] : []),
    ...antigravityToolCallBlocks(record.tool_calls, fallbackId)
  ]
  const status = extractString(record.status)
  const isCanceled = status === 'CANCELED' || status === 'CANCELLED'
  const serving = antigravityServing(record, isCanceled || status === 'ERROR')
  const messages: NativeChatMessage[] = [
    ...(thinking
      ? [
          transcriptMsg(
            `${baseId}:reasoning`,
            'reasoning',
            [{ type: 'text', text: thinking }],
            timestamp
          )
        ]
      : []),
    ...(blocks.length > 0 ? [transcriptMsg(baseId, 'assistant', blocks, timestamp, serving)] : [])
  ]
  if (messages.length > 0) {
    return messages.length === 1 ? messages[0]! : messages
  }
  return isCanceled
    ? transcriptMsg(
        baseId,
        'system',
        [{ type: 'text', text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT }],
        timestamp
      )
    : null
}

function decodeAntigravityToolResultRecord(
  record: Record<string, unknown>,
  id: string,
  timestamp: number | null
): NativeChatMessage | null {
  const output = toolResultOutput(record.content ?? record.output ?? record.result).replace(
    SYSTEM_MESSAGE_SUFFIX,
    ''
  )
  const isError = extractString(record.status) === 'ERROR' || record.is_error === true
  const callId = extractString(record.tool_call_id) ?? extractString(record.call_id)
  return !output.trim() && !isError
    ? null
    : transcriptMsg(
        id,
        'tool',
        [
          {
            type: 'tool-result',
            output,
            ...(callId ? { callId } : {}),
            ...(isError ? { isError: true } : {})
          }
        ],
        timestamp
      )
}

function antigravityToolCallBlocks(value: unknown, fallbackId: string): NativeChatBlock[] {
  if (!Array.isArray(value)) {
    return []
  }
  const isFullTranscript = fallbackId.includes('transcript_full.jsonl')
  return value.flatMap((item): NativeChatBlock[] => {
    const call = asRecord(item)
    if (!call) {
      return []
    }
    const rawName = (extractString(call.name) ?? extractString(call.tool) ?? 'tool').replace(
      /^default_api:/,
      ''
    )
    const callId = extractString(call.id) ?? extractString(call.call_id)
    const input = normalizeAntigravityToolArgs(
      call.args ?? call.arguments ?? call.input,
      isFullTranscript
    )
    const args = asRecord(input)
    const eagerMcp = /^mcp_([^_]+)_(.+)$/.exec(rawName)
    const server =
      rawName === 'call_mcp_tool' ? extractString(args?.ServerName) : (eagerMcp?.[1] ?? null)
    const tool =
      rawName === 'call_mcp_tool' ? extractString(args?.ToolName) : (eagerMcp?.[2] ?? null)
    return [
      server && tool
        ? {
            type: 'tool-call',
            name: tool,
            mcpIdentity: { server, tool },
            input: rawName === 'call_mcp_tool' ? (args?.Arguments ?? input) : input,
            ...(callId ? { callId } : {})
          }
        : { type: 'tool-call', name: rawName, input, ...(callId ? { callId } : {}) }
    ]
  })
}

/** Compact transcript.jsonl wraps top-level argument values in JSON strings; unwrap one layer without turning string fields into objects. */
function normalizeAntigravityToolArgs(value: unknown, isFullTranscript: boolean): unknown {
  const record = asRecord(value)
  if (!record || isFullTranscript) {
    return value ?? null
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, field]) => {
      if (typeof field !== 'string') {
        return [key, field]
      }
      const trimmed = field.trim()
      const allowStructured =
        (key === 'questions' || key === 'Arguments') &&
        /^(?:\{[\s\S]*\}|\[[\s\S]*\])$/.test(trimmed)
      if (!allowStructured && !/^"[\s\S]*"$/.test(trimmed)) {
        return [key, field]
      }
      try {
        return [key, JSON.parse(trimmed)]
      } catch {
        return [key, field]
      }
    })
  )
}

export function isAntigravityCompactionSummary(content: string): boolean {
  return (
    (content.includes('<CONTEXT_SUMMARY>') || content.includes('# Resuming from a compaction')) &&
    !content.includes(USER_REQUEST_OPENER)
  )
}

export function unwrapAntigravityUserText(content: string): string | null {
  if (!content.trim()) {
    return null
  }
  const start = content.indexOf(USER_REQUEST_OPENER)
  const bodyStart = start + USER_REQUEST_OPENER.length
  const end = start === -1 ? -1 : content.indexOf(USER_REQUEST_CLOSER, bodyStart)
  const body = start === -1 ? content : content.slice(bodyStart, end === -1 ? undefined : end)
  return (
    body
      .replace(SYSTEM_MESSAGE_SUFFIX, '')
      .replace(
        /<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE)>[\s\S]*?(?:<\/(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE)>|$)/g,
        ''
      )
      .trim() || null
  )
}

function antigravityMediaBlocks(media: unknown): NativeChatImageRefBlock[] {
  return !Array.isArray(media)
    ? []
    : media.flatMap((item): NativeChatImageRefBlock[] => {
        const record = asRecord(item)
        const uri = extractString(record?.uri)
        const mime = extractString(record?.mime_type)
        if (!uri || (mime && !mime.startsWith('image/'))) {
          return []
        }
        if (uri.startsWith('data:') || /^https?:\/\//i.test(uri)) {
          return [{ type: 'image-ref', url: uri }]
        }
        try {
          return [{ type: 'image-ref', path: uri.startsWith('file://') ? fileURLToPath(uri) : uri }]
        } catch {
          return [{ type: 'image-ref', url: uri }]
        }
      })
}

function antigravityServing(
  record: Record<string, unknown>,
  excludeUsage: boolean
): Pick<NativeChatMessage, 'model' | 'usage'> {
  const model =
    extractString(record.model) ??
    extractString(record.model_name) ??
    extractString(record.modelName)
  const nested = asRecord(record.usage) ?? record
  const inputTokens = tokenCount(nested.input_tokens ?? nested.inputTokens)
  const outputTokens = tokenCount(nested.output_tokens ?? nested.outputTokens)
  const cacheReadInputTokens = tokenCount(nested.cache_read_tokens ?? nested.cacheReadInputTokens)
  const cacheCreationInputTokens = tokenCount(
    nested.cache_creation_tokens ?? nested.cacheCreationInputTokens
  )
  const usage: AgentSessionTokenUsage | null =
    !excludeUsage &&
    inputTokens + outputTokens + cacheReadInputTokens + cacheCreationInputTokens > 0
      ? { inputTokens, cacheCreationInputTokens, cacheReadInputTokens, outputTokens }
      : null
  return { ...(model ? { model } : {}), ...(usage ? { usage } : {}) }
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}
