import type { AiVaultSessionPreviewMessage } from '../../shared/ai-vault-types'
import { asRecord } from './session-scanner-record-value'

export type DecodedToolCall = {
  kind: 'tool_call'
  name: string | null
  argument: string | null
}

export type DecodedSessionBlock =
  | { kind: 'text' | 'reasoning'; text: string }
  | DecodedToolCall
  | { kind: 'tool_result'; textParts: Iterable<string> }

export type SessionMessageDecodeOptions = { includeTools?: boolean }

export type DecodedSessionMessage = {
  role: AiVaultSessionPreviewMessage['role']
  blocks: readonly DecodedSessionBlock[]
  timestamp: string | null
}

const TEXT_BLOCK_TYPES = new Set(['text', 'input_text', 'output_text'])
const TOOL_INPUT_KEYS = ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'description']

export function decodeToolCall(name: unknown, input: unknown): DecodedToolCall {
  const toolName = typeof name === 'string' && name.trim() ? name.trim() : null
  const inputRecord = asRecord(input)
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
  return { kind: 'tool_call', name: toolName, argument }
}

function* toolResultParts(content: unknown): Generator<string> {
  if (typeof content === 'string') {
    if (content) {
      yield content
    }
    return
  }
  if (!Array.isArray(content)) {
    return
  }
  for (const item of content) {
    const text = typeof item === 'string' ? item : asRecord(item)?.text
    if (typeof text === 'string' && text) {
      yield text
    }
  }
}

export function decodeSessionMessage(
  role: AiVaultSessionPreviewMessage['role'],
  content: unknown,
  timestamp: string | null,
  options: SessionMessageDecodeOptions = {}
): DecodedSessionMessage {
  const blocks: DecodedSessionBlock[] = []
  const values = Array.isArray(content) ? content : content != null ? [content] : []
  for (const value of values) {
    if (typeof value === 'string') {
      blocks.push({ kind: 'text', text: value })
      continue
    }
    const item = asRecord(value)
    if (!item) {
      continue
    }
    const type = typeof item.type === 'string' ? item.type.toLowerCase() : null
    if (type === 'tool_use') {
      if (options.includeTools !== false) {
        blocks.push(decodeToolCall(item.name, item.input))
      }
      continue
    }
    if (type === 'tool_result') {
      if (options.includeTools !== false) {
        const content = item.content
        blocks.push({
          kind: 'tool_result',
          textParts: { [Symbol.iterator]: () => toolResultParts(content) }
        })
      }
      continue
    }
    const reasoning = type === 'thinking' || type === 'reasoning'
    if (type !== null && !TEXT_BLOCK_TYPES.has(type) && !reasoning) {
      continue
    }
    const text = typeof item.text === 'string' ? item.text : item.content
    if (typeof text === 'string' && text) {
      blocks.push({ kind: reasoning ? 'reasoning' : 'text', text })
    }
  }
  return { role, blocks, timestamp }
}
