import type {
  NativeChatBlock,
  NativeChatImageRefBlock,
  NativeChatToolResultBlock
} from '../../shared/native-chat/native-chat-types'
import { asRecord, extractString } from '../ai-vault/session-scanner-values'
import {
  isClaudeToolUseContent,
  isClaudeToolResultContent,
  claudeToolResultTextParts,
  claudeToolResultFailed
} from '../../shared/claude-tool-content'
import { finishTranscriptWork, type TranscriptWork } from './transcript-work-scheduler'

export function toolResultOutput(value: unknown): string {
  return finishTranscriptWork(toolResultOutputWork(value))
}

export function* toolResultOutputWork(value: unknown): TranscriptWork<string> {
  if (typeof value === 'string') {
    return value
  }
  if (!Array.isArray(value)) {
    const record = asRecord(value)
    if (record) {
      const text = extractString(record.text) ?? extractString(record.content)
      if (text) {
        return text
      }
    }
    return value === undefined || value === null ? '' : JSON.stringify(value)
  }
  const parts: string[] = []
  for (const item of value) {
    yield 1
    if (typeof item === 'string') {
      parts.push(item)
      continue
    }
    const record = asRecord(item)
    const text = extractString(record?.text) ?? extractString(record?.content)
    if (text) {
      parts.push(text)
    }
  }
  return parts.join('\n')
}

export function claudeContentBlocks(content: unknown): NativeChatBlock[] {
  return finishTranscriptWork(claudeContentBlocksWork(content))
}

export function* claudeContentBlocksWork(content: unknown): TranscriptWork<NativeChatBlock[]> {
  if (typeof content === 'string') {
    const text = content.trim()
    return text ? [{ type: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) {
    return []
  }
  const blocks: NativeChatBlock[] = []
  for (const item of content) {
    yield 1
    if (typeof item === 'string') {
      if (item.trim()) {
        blocks.push({ type: 'text', text: item })
      }
      continue
    }
    const record = asRecord(item)
    if (!record) {
      continue
    }
    let block: NativeChatBlock | null
    switch (record.type) {
      case 'text': {
        const text = extractString(record.text)
        block = text ? { type: 'text', text } : null
        break
      }
      case 'thinking': {
        // Reasoning uses text blocks; message role carries its classification.
        const text = extractString(record.thinking) ?? extractString(record.text)
        block = text ? { type: 'text', text } : null
        break
      }
      case 'tool_use': {
        const name = extractString(record.name) ?? 'tool'
        const callId = extractString(record.id)
        block = { type: 'tool-call', name, input: record.input, ...(callId ? { callId } : {}) }
        break
      }
      case 'tool_result':
        block = yield* toolResultBlockWork(record)
        break
      case 'image':
        block = imageRefBlock(record)
        break
      default:
        if (isClaudeToolUseContent(record)) {
          block = {
            type: 'tool-call',
            name: String(record.name),
            input: record.input,
            callId: String(record.id)
          }
        } else if (isClaudeToolResultContent(record)) {
          block = yield* legacyToolResultBlockWork(record)
        } else {
          block = null
        }
    }
    if (block) {
      blocks.push(block)
    }
  }
  return blocks
}

function* legacyToolResultBlockWork(
  record: Record<string, unknown>
): TranscriptWork<NativeChatToolResultBlock> {
  const parts: string[] = []
  const content = Array.isArray(record.content) ? record.content : [record.content]
  for (const part of content) {
    yield 1
    for (const text of claudeToolResultTextParts([part])) {
      parts.push(text)
    }
  }
  return {
    type: 'tool-result',
    callId: String(record.tool_use_id),
    output: parts.join('\n'),
    ...(claudeToolResultFailed(record) ? { isError: true } : {})
  }
}

function* toolResultBlockWork(
  record: Record<string, unknown>
): TranscriptWork<NativeChatToolResultBlock> {
  const callId = extractString(record.tool_use_id)
  return {
    type: 'tool-result',
    output: yield* toolResultOutputWork(record.content),
    ...(callId ? { callId } : {}),
    ...(record.is_error === true ? { isError: true } : {})
  }
}

function imageRefBlock(record: Record<string, unknown>): NativeChatImageRefBlock | null {
  const source = asRecord(record.source)
  const url = extractString(source?.url) ?? extractString(record.url)
  const path = extractString(record.path)
  const alt = extractString(record.alt) ?? undefined
  if (!url && !path) {
    return null
  }
  return {
    type: 'image-ref',
    ...(path ? { path } : {}),
    ...(url ? { url } : {}),
    ...(alt ? { alt } : {})
  }
}
