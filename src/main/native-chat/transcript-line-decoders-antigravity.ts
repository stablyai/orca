// Antigravity (AGY) JSONL line → NativeChatMessage decoder.

import type { NativeChatBlock, NativeChatMessage } from '../../shared/native-chat-types'
import {
  asRecord,
  extractString,
  parseJsonObject,
  timestampMs
} from '../ai-vault/session-scanner-values'
import { extractAntigravityUserRequest } from '../ai-vault/session-scanner-antigravity-parser'

const TOOL_STEP_TYPES = new Set([
  'RUN_COMMAND',
  'LIST_DIRECTORY',
  'GENERIC',
  'INVOKE_SUBAGENT',
  'VIEW_FILE',
  'CODE_ACTION',
  'GREP_SEARCH',
  'SEARCH_WEB'
])

export function decodeAntigravityTranscriptLine(
  line: string,
  fallbackId: string
): NativeChatMessage | null {
  const record = parseJsonObject(line)
  if (!record) {
    return null
  }

  const timestamp = parseTimestamp(record.created_at ?? record.timestamp)
  // Antigravity's created_at clock is second-granular; a fallback timestamp has no such contract.
  const coarseTimestamp =
    (typeof record.created_at === 'string' ||
      (typeof record.created_at === 'number' && record.created_at <= 1_000_000_000_000)) &&
    timestamp !== null &&
    timestamp % 1000 === 0
  const stepIndex =
    typeof record.step_index === 'number'
      ? String(record.step_index)
      : (extractString(record.step_index) ?? extractString(record.id))
  const id = stepIndex ?? fallbackId
  const ordinal = stepIndex && /^\d+$/.test(stepIndex) ? Number(stepIndex) : undefined
  const transcriptPosition =
    ordinal !== undefined && Number.isSafeInteger(ordinal) ? ordinal : undefined
  const source = extractString(record.source)
  const type = extractString(record.type)

  if (
    (source === 'USER_EXPLICIT' || source === 'USER') &&
    (type === 'USER_INPUT' || type === 'REQUEST')
  ) {
    const rawContent = extractString(record.content) ?? ''
    const text = extractAntigravityUserRequest(rawContent) || rawContent
    if (!text.trim()) {
      return null
    }
    return {
      id,
      role: 'user',
      blocks: [{ type: 'text', text }],
      timestamp,
      ...(coarseTimestamp ? { timestampPrecision: 'second' as const } : {}),
      ...(transcriptPosition === undefined ? {} : { transcriptPosition }),
      source: 'transcript'
    }
  }

  if (source === 'MODEL' && type === 'PLANNER_RESPONSE') {
    const blocks: NativeChatBlock[] = []

    const thinking = extractString(record.thinking)
    if (thinking && thinking.trim()) {
      blocks.push({ type: 'text', text: `> *Thinking:*\n${thinking}` })
    }

    const content = extractString(record.content)
    if (content && content.trim()) {
      blocks.push({ type: 'text', text: content })
    }

    blocks.push(...toolCallBlocks(record.tool_calls))

    if (blocks.length === 0) {
      return null
    }

    return {
      id,
      role: 'assistant',
      blocks,
      timestamp,
      ...(coarseTimestamp ? { timestampPrecision: 'second' as const } : {}),
      ...(transcriptPosition === undefined ? {} : { transcriptPosition }),
      source: 'transcript'
    }
  }

  // Recorded tool steps are MODEL records, not TOOL_RESULT messages.
  if (source === 'MODEL' && type && TOOL_STEP_TYPES.has(type)) {
    const output = extractString(record.content)
    const blocks = toolCallBlocks(record.tool_calls)
    const isError =
      record.status === 'ERROR' || (typeof record.exit_code === 'number' && record.exit_code !== 0)
    if (output) {
      blocks.push({ type: 'tool-result', output, ...(isError ? { isError: true } : {}) })
    }
    if (blocks.length === 0) {
      return null
    }
    return {
      id,
      role: 'tool',
      blocks,
      timestamp,
      ...(coarseTimestamp ? { timestampPrecision: 'second' as const } : {}),
      ...(transcriptPosition === undefined ? {} : { transcriptPosition }),
      source: 'transcript'
    }
  }

  return null
}

function parseTimestamp(value: unknown): number | null {
  const parsed = timestampMs(value)
  return Number.isFinite(parsed) ? parsed : null
}

function toolCallBlocks(value: unknown): NativeChatBlock[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((call) => {
    const tool = asRecord(call)
    return tool
      ? [
          {
            type: 'tool-call' as const,
            name: extractString(tool.name) ?? 'tool',
            input: tool.args ?? tool.arguments ?? tool.input ?? null
          }
        ]
      : []
  })
}
