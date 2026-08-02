import type { AgentType, NativeChatBlock, NativeChatMessage } from '../../shared/native-chat-types'
import { nativeChatTextRetrievalCapabilities } from './text-retrieval-capabilities'
import { transcriptRecordOffset } from './transcript-record-position'

export const MOBILE_NATIVE_CHAT_DEFAULT_WINDOW = 40
export const MOBILE_NATIVE_CHAT_MAX_WINDOW = 2000

const MOBILE_BLOCK_CHAR_CAP = 4000
const MOBILE_TOOL_INPUT_ITEMS_CAP = 20
const MOBILE_TOOL_INPUT_NODE_CAP = 100
const TRUNCATION_MARKER = '\n… (truncated)'

export type AuthorizedNativeChatPayloadSession = {
  owner: string
  agent: AgentType
  sessionId: string
  transcriptPath?: string
}

function clip(text: string): string {
  if (text.length <= MOBILE_BLOCK_CHAR_CAP) {
    return text
  }
  let end = MOBILE_BLOCK_CHAR_CAP
  const previous = text.charCodeAt(end - 1)
  const next = text.charCodeAt(end)
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    end--
  }
  return text.slice(0, end) + TRUNCATION_MARKER
}

function clipBlock(
  block: NativeChatBlock,
  blockIndex: number,
  recordOffset: number | undefined,
  messageId: string,
  session: AuthorizedNativeChatPayloadSession
): NativeChatBlock {
  if (block.type === 'text') {
    if (block.text.length <= MOBILE_BLOCK_CHAR_CAP) {
      return block
    }
    return {
      ...block,
      text: clip(block.text),
      ...(recordOffset === undefined
        ? {}
        : {
            retrieval: {
              capability: nativeChatTextRetrievalCapabilities.issue({
                ...session,
                messageId,
                recordOffset,
                blockIndex,
                originalChars: block.text.length,
                text: block.text
              }),
              originalChars: block.text.length
            }
          })
    }
  }
  if (block.type === 'tool-result') {
    return block.output.length > MOBILE_BLOCK_CHAR_CAP
      ? { ...block, output: clip(block.output) }
      : block
  }
  if (block.type === 'tool-call') {
    const budget = { remaining: MOBILE_BLOCK_CHAR_CAP, nodes: MOBILE_TOOL_INPUT_NODE_CAP }
    return { ...block, input: sanitizeToolInput(block.input, budget, 0) }
  }
  return block
}

function sanitizeToolInput(
  value: unknown,
  budget: { remaining: number; nodes: number },
  depth: number
): unknown {
  budget.nodes--
  if (budget.nodes < 0 || budget.remaining <= 0) {
    return '… (truncated)'
  }
  if (typeof value === 'string') {
    const length = Math.min(value.length, budget.remaining)
    budget.remaining -= length
    return length < value.length ? `${value.slice(0, length)}… (truncated)` : value
  }
  if (!value || typeof value !== 'object' || depth >= 5) {
    return value && typeof value === 'object' ? '… (truncated)' : value
  }
  if (Array.isArray(value)) {
    const result = value
      .slice(0, MOBILE_TOOL_INPUT_ITEMS_CAP)
      .map((item) => sanitizeToolInput(item, budget, depth + 1))
    if (value.length > MOBILE_TOOL_INPUT_ITEMS_CAP) {
      result.push('… (truncated)')
    }
    return result
  }
  const result: Record<string, unknown> = {}
  let count = 0
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      continue
    }
    if (count >= MOBILE_TOOL_INPUT_ITEMS_CAP || budget.remaining <= 0) {
      result['…'] = 'truncated'
      break
    }
    let boundedKey = key.slice(0, Math.min(key.length, budget.remaining, 128))
    // Why: sibling keys sharing a bounded prefix must not silently replace one another.
    if (Object.prototype.hasOwnProperty.call(result, boundedKey)) {
      boundedKey = `${boundedKey}~${count}`
    }
    budget.remaining -= boundedKey.length
    result[boundedKey] = sanitizeToolInput(
      (value as Record<string, unknown>)[key],
      budget,
      depth + 1
    )
    count++
  }
  return result
}

function sanitizeMessage(
  message: NativeChatMessage,
  session: AuthorizedNativeChatPayloadSession
): NativeChatMessage {
  const recordOffset = transcriptRecordOffset(message)
  return {
    ...message,
    blocks: message.blocks.map((block, blockIndex) =>
      clipBlock(block, blockIndex, recordOffset, message.id, session)
    )
  }
}

export function sanitizeAppendForClient(
  messages: readonly NativeChatMessage[],
  clientKind: 'mobile' | 'runtime' | undefined,
  session: AuthorizedNativeChatPayloadSession
): NativeChatMessage[] {
  return clientKind === 'mobile'
    ? messages.map((message) => sanitizeMessage(message, session))
    : messages.slice()
}

export function windowForClient(
  messages: readonly NativeChatMessage[],
  clientKind: 'mobile' | 'runtime' | undefined,
  session: AuthorizedNativeChatPayloadSession,
  limit = MOBILE_NATIVE_CHAT_DEFAULT_WINDOW
): NativeChatMessage[] {
  const window = Math.min(Math.max(limit, 1), MOBILE_NATIVE_CHAT_MAX_WINDOW)
  const windowed = messages.length > window ? messages.slice(-window) : messages.slice()
  return clientKind === 'mobile'
    ? windowed.map((message) => sanitizeMessage(message, session))
    : windowed
}
