import type { NativeChatBlock, NativeChatMessage } from '../../../../shared/native-chat-types'
import type { RpcContext } from '../core'
import { sanitizeNativeChatRpcImageBlock } from './native-chat-rpc-image-block'

export const MOBILE_NATIVE_CHAT_DEFAULT_WINDOW = 40
export const MOBILE_NATIVE_CHAT_MAX_WINDOW = 2000
const MOBILE_BLOCK_CHAR_CAP = 4000
const MOBILE_TEXT_BLOCK_CHAR_CAP = 64_000
const MOBILE_TOOL_INPUT_ITEMS_CAP = 20
const MOBILE_TOOL_INPUT_NODE_CAP = 100
const TRUNCATION_MARKER = '\n… (truncated)'

function clip(text: string, cap: number): string {
  return text.length > cap ? text.slice(0, cap) + TRUNCATION_MARKER : text
}

function selectBoundedObjectKey(
  key: string,
  result: Record<string, unknown>,
  maxLength: number
): string | null {
  const prefix = key.slice(0, maxLength)
  if (!Object.hasOwn(result, prefix)) {
    return prefix
  }
  for (let index = 1; index <= MOBILE_TOOL_INPUT_ITEMS_CAP; index++) {
    const suffix = `~${index.toString(36)}`
    const candidate =
      suffix.length <= maxLength
        ? `${prefix.slice(0, maxLength - suffix.length)}${suffix}`
        : index.toString(36).slice(-maxLength)
    if (candidate && !Object.hasOwn(result, candidate)) {
      return candidate
    }
  }
  return null
}

function sanitizeBlock(
  block: NativeChatBlock,
  clientKind: RpcContext['clientKind']
): NativeChatBlock {
  if (block.type === 'image-ref') {
    return sanitizeNativeChatRpcImageBlock(block)
  }
  if (clientKind !== 'mobile') {
    return block
  }
  if (block.type === 'text') {
    return block.text.length > MOBILE_TEXT_BLOCK_CHAR_CAP
      ? { ...block, text: clip(block.text, MOBILE_TEXT_BLOCK_CHAR_CAP) }
      : block
  }
  if (block.type === 'tool-result') {
    return block.output.length > MOBILE_BLOCK_CHAR_CAP
      ? { ...block, output: clip(block.output, MOBILE_BLOCK_CHAR_CAP) }
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
  const result = Object.create(null) as Record<string, unknown>
  let count = 0
  for (const key in value) {
    if (!Object.hasOwn(value, key)) {
      continue
    }
    if (count >= MOBILE_TOOL_INPUT_ITEMS_CAP || budget.remaining <= 0) {
      result['…'] = 'truncated'
      break
    }
    const boundedKey = selectBoundedObjectKey(
      key,
      result,
      Math.min(key.length, budget.remaining, 128)
    )
    if (boundedKey === null) {
      result['…'] = 'truncated'
      break
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
  clientKind: RpcContext['clientKind']
): NativeChatMessage {
  return { ...message, blocks: message.blocks.map((block) => sanitizeBlock(block, clientKind)) }
}

export function sanitizeAppendForClient(
  messages: readonly NativeChatMessage[],
  clientKind: RpcContext['clientKind']
): NativeChatMessage[] {
  return messages.map((message) => sanitizeMessage(message, clientKind))
}

export function windowForClient(
  messages: readonly NativeChatMessage[],
  clientKind: RpcContext['clientKind'],
  limit = MOBILE_NATIVE_CHAT_DEFAULT_WINDOW
): NativeChatMessage[] {
  const window = Math.min(Math.max(limit, 1), MOBILE_NATIVE_CHAT_MAX_WINDOW)
  const windowed = messages.length > window ? messages.slice(-window) : messages.slice()
  return windowed.map((message) => sanitizeMessage(message, clientKind))
}
