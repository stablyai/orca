// Antigravity (AGY) JSONL line → NativeChatMessage decoder.

import type { NativeChatBlock, NativeChatMessage } from '../../shared/native-chat-types'
import {
  asRecord,
  extractString,
  parseJsonObject,
  timestampMs
} from '../ai-vault/session-scanner-values'
import { toolResultOutput } from './transcript-record-blocks'

export function decodeAntigravityTranscriptLine(
  line: string,
  fallbackId: string
): NativeChatMessage | null {
  const record = parseJsonObject(line)
  if (!record) {
    return null
  }

  const timestamp = parseTimestamp(record.created_at ?? record.timestamp)
  const stepIndex =
    typeof record.step_index === 'number'
      ? String(record.step_index)
      : extractString(record.step_index) ?? extractString(record.id)
  const id = stepIndex ?? fallbackId
  const source = extractString(record.source)
  const type = extractString(record.type)

  // 1. User Prompt
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
      source: 'transcript'
    }
  }

  // 2. Model / Assistant Response
  if (source === 'MODEL' && type === 'PLANNER_RESPONSE') {
    const blocks: NativeChatBlock[] = []

    // Reasoning / Thinking block
    const thinking = extractString(record.thinking)
    if (thinking && thinking.trim()) {
      blocks.push({ type: 'text', text: `> *Thinking:*\n${thinking}` })
    }

    // Assistant text content
    const content = extractString(record.content)
    if (content && content.trim()) {
      blocks.push({ type: 'text', text: content })
    }

    // Tool calls
    if (Array.isArray(record.tool_calls)) {
      for (const call of record.tool_calls) {
        const tool = asRecord(call)
        if (tool) {
          const name = extractString(tool.name) ?? 'tool'
          const input = tool.arguments ?? tool.input ?? null
          blocks.push({
            type: 'tool-call',
            name,
            input
          })
        }
      }
    }

    if (blocks.length === 0) {
      return null
    }

    return {
      id,
      role: 'assistant',
      blocks,
      timestamp,
      source: 'transcript'
    }
  }

  // 3. Tool Result
  if (
    (source === 'SYSTEM' || source === 'USER' || source === 'TOOL') &&
    (type === 'TOOL_RESULT' || type === 'TOOL_RESPONSE' || type === 'tool_result')
  ) {
    const isError = record.status === 'ERROR' || record.is_error === true
    const output = record.content ?? record.output ?? record.result
    return {
      id,
      role: 'tool',
      blocks: [
        {
          type: 'tool-result',
          output: toolResultOutput(output),
          ...(isError ? { isError: true } : {})
        }
      ],
      timestamp,
      source: 'transcript'
    }
  }

  return null
}

export function extractAntigravityUserRequest(content: string): string | null {
  const opener = '<USER_REQUEST>'
  const startIndex = content.indexOf(opener)
  if (startIndex === -1) {
    return extractString(content)
  }
  const bodyStart = startIndex + opener.length
  const endIndex = content.indexOf('</USER_REQUEST>', bodyStart)
  return extractString(
    endIndex === -1 ? content.slice(bodyStart) : content.slice(bodyStart, endIndex)
  )
}

function parseTimestamp(value: unknown): number | null {
  const parsed = timestampMs(value)
  return Number.isFinite(parsed) ? parsed : null
}
