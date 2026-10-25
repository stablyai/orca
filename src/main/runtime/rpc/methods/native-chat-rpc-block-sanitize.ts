import {
  MAX_SUBAGENT_FIELD_CHARS,
  normalizeSubagentState
} from '../../../../shared/native-chat-subagent-summary'
import { fitInteractivePrompt } from '../../../../shared/agent-status-field-normalization'
import { parseAskFromToolInput } from '../../../../shared/native-chat-ask'
import type { NativeChatBlock, NativeChatSubagentState } from '../../../../shared/native-chat-types'
import { boundSubagentEntryId } from '../../../native-chat/subagent-entry-id-bounds'
import type { RpcContext } from '../core'
import { sanitizeNativeChatRpcImageBlock } from './native-chat-rpc-image-block'

// Mobile previews tool bodies; cap large results on the wire and mark clipped content.
const MOBILE_BLOCK_CHAR_CAP = 4000
// Text is the full message, not a preview (STA-3230); use a higher ceiling so large records cannot freeze the phone.
const MOBILE_TEXT_BLOCK_CHAR_CAP = 64_000
const MOBILE_TOOL_INPUT_ITEMS_CAP = 20
const MOBILE_TOOL_INPUT_NODE_CAP = 100
// Newer/imported spawn rosters can exceed this build's child and field bounds.
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
    return { ...block, input: sanitizeToolInput(fitAskToolInput(block), budget, 0) }
  }
  if (block.type === 'subagent-group') {
    return {
      ...block,
      groupId: clip(block.groupId, MAX_SUBAGENT_FIELD_CHARS),
      agents: block.agents.slice(0, MOBILE_SUBAGENT_CAP).map((agent) => ({
        ...agent,
        // Ids are roster keys; digest-bound them because prefix clipping would merge children.
        id: boundSubagentEntryId(agent.id),
        label: clip(agent.label, MAX_SUBAGENT_FIELD_CHARS),
        state: clipSubagentState(agent.state)
      }))
    }
  }
  if (block.type === 'subagent') {
    return {
      ...block,
      id: boundSubagentEntryId(block.id),
      label: clip(block.label, MAX_SUBAGENT_FIELD_CHARS),
      state: clipSubagentState(block.state),
      groupId: clip(block.groupId, MAX_SUBAGENT_FIELD_CHARS),
      ...(block.parentId !== undefined ? { parentId: boundSubagentEntryId(block.parentId) } : {}),
      ...(block.run !== undefined ? { run: clip(block.run, MAX_SUBAGENT_FIELD_CHARS) } : {})
    }
  }
  return block
}

/** Oversize states are unknown; clipping would invent a lifecycle word. */
function clipSubagentState(value: NativeChatSubagentState): NativeChatSubagentState {
  return value.length > MAX_SUBAGENT_FIELD_CHARS ? normalizeSubagentState(value) : value
}

// Preserve question labels by shortening presentation text before the generic budget drops options.
function fitAskToolInput(block: Extract<NativeChatBlock, { type: 'tool-call' }>): unknown {
  const { name, input } = block
  if (typeof input === 'string' && input.length <= MOBILE_BLOCK_CHAR_CAP) {
    return input
  }
  if (!parseAskFromToolInput(name, input)) {
    return input
  }
  const encoded = typeof input === 'string' ? input : JSON.stringify(input)
  if (encoded.length <= MOBILE_BLOCK_CHAR_CAP) {
    return input
  }
  const fitted = fitInteractivePrompt(encoded, (text) => text.length <= MOBILE_BLOCK_CHAR_CAP)
  if (fitted === null) {
    return input
  }
  return typeof input === 'string' ? fitted : JSON.parse(fitted)
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
    // Suffix colliding bounded keys so shared long prefixes cannot silently lose sibling fields.
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
