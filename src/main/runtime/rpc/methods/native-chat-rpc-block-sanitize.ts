import {
  MAX_SUBAGENT_FIELD_CHARS,
  normalizeSubagentState
} from '../../../../shared/native-chat-subagent-summary'
import type { NativeChatBlock, NativeChatSubagentState } from '../../../../shared/native-chat-types'
import type { RpcContext } from '../core'
import { sanitizeNativeChatRpcImageBlock } from './native-chat-rpc-image-block'

// Why: the mobile-only payload diet. Inline image bytes are kept off every RPC
// transport; everything below that only applies to `mobile` clients, whose
// renderer previews block bodies rather than showing them whole.

// Why: a single tool result (a big file read, a long diff) can be hundreds of KB.
// The mobile view only previews tool block bodies, so truncate them on the wire
// to keep the payload small; the marker tells the user content was clipped.
const MOBILE_BLOCK_CHAR_CAP = 4000
// Why: text blocks are the message body itself, rendered in full by the chat
// view — a preview-sized cap cut long assistant replies mid-sentence with no way
// to read on (STA-3230). Keep only a generous safety ceiling: a transcript
// record can legally reach 2MB, and shipping that much markdown in one block
// would freeze the phone.
const MOBILE_TEXT_BLOCK_CHAR_CAP = 64_000
const MOBILE_TOOL_INPUT_ITEMS_CAP = 20
const MOBILE_TOOL_INPUT_NODE_CAP = 100
// Why: a spawn group's roster is metadata, not a body — provider-supplied agent
// paths and an open-string lifecycle whose schema declares no maximum, so a
// journal from a newer build can carry more children and longer strings than
// this build ever writes.
const MOBILE_SUBAGENT_CAP = 64
const TRUNCATION_MARKER = '\n… (truncated)'

function clip(text: string, cap: number): string {
  return text.length > cap ? text.slice(0, cap) + TRUNCATION_MARKER : text
}

export function sanitizeNativeChatRpcBlock(
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
  if (block.type === 'subagent-group') {
    return {
      ...block,
      groupId: clip(block.groupId, MAX_SUBAGENT_FIELD_CHARS),
      agents: block.agents.slice(0, MOBILE_SUBAGENT_CAP).map((agent) => ({
        ...agent,
        id: clip(agent.id, MAX_SUBAGENT_FIELD_CHARS),
        label: clip(agent.label, MAX_SUBAGENT_FIELD_CHARS),
        state: clipSubagentState(agent.state)
      }))
    }
  }
  return block
}

/** A state too long to be one this build knows names no state at all, which is
 *  what `unverifiable` records — clipping it would ship a truncated word. */
function clipSubagentState(value: NativeChatSubagentState): NativeChatSubagentState {
  return value.length > MAX_SUBAGENT_FIELD_CHARS ? normalizeSubagentState(value) : value
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
    if (!Object.hasOwn(value, key)) {
      continue
    }
    if (count >= MOBILE_TOOL_INPUT_ITEMS_CAP || budget.remaining <= 0) {
      result['…'] = 'truncated'
      break
    }
    let boundedKey = key.slice(0, Math.min(key.length, budget.remaining, 128))
    // Why: sibling keys sharing a >=128-char (or budget-truncated) prefix collapse
    // to the same bounded key; suffix collisions so neither field is silently lost.
    if (Object.hasOwn(result, boundedKey)) {
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
