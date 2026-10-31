const MAX_LEGACY_IMPORT_SUBAGENTS = 64
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { NativeChatBlock, NativeChatMessage } from '../../../shared/native-chat-types'
import { boundSubagentEntryId } from '../subagent-entry-id-bounds'
import type { JournalReplacementItem } from './journal-epoch-replacement'
import {
  boundInlineText,
  boundToolInput,
  type JournalPayloadLimits
} from './journal-payload-bounds'
export const LEGACY_IMPORT_BLOCK_LIMITS: JournalPayloadLimits = { inlineHeadBytes: 16 * 1024 }

export function replacementItems(
  messages: readonly NativeChatMessage[],
  identities: readonly AgentJournalItemIdentity[],
  limits: JournalPayloadLimits
): JournalReplacementItem[] {
  const replacement: JournalReplacementItem[] = []
  for (const [index, message] of messages.entries()) {
    const identity = identities[index]
    if (identity) {
      replacement.push(replacementItem(message, identity, limits))
    }
  }
  return replacement
}

export function replacementItem(
  message: NativeChatMessage,
  identity: AgentJournalItemIdentity,
  limits: JournalPayloadLimits
): JournalReplacementItem {
  return {
    identity,
    body: legacyItemBody(message, limits),
    observedAt: message.timestamp ?? undefined,
    // Imported history belongs to no active generation, even when saved rows claim to be running.
    ownerFence: 0
  }
}

export function legacyItemBody(
  message: NativeChatMessage,
  limits?: JournalPayloadLimits
): AgentJournalItemBody {
  const only = message.blocks.length === 1 ? message.blocks[0] : undefined
  if (only?.type === 'tool-call') {
    // Bound adoption before epoch publication; catch-up uses whole-batch admission.
    return {
      kind: 'tool-call',
      name: only.name,
      input: limits ? boundToolInput(only.input, limits) : only.input,
      ...(only.callId !== undefined ? { callId: only.callId } : {}),
      state: 'completed'
    }
  }
  return {
    kind: 'message',
    role: message.role,
    blocks: limits ? message.blocks.map((block) => boundBlock(block, limits)) : message.blocks
  }
}

export function boundBlock(block: NativeChatBlock, limits: JournalPayloadLimits): NativeChatBlock {
  if (block.type === 'text') {
    return { ...block, text: boundInlineText(block.text, limits).text }
  }
  if (block.type === 'tool-result') {
    return { ...block, output: boundInlineText(block.output, limits).text }
  }
  if (block.type === 'tool-call') {
    return { ...block, input: boundToolInput(block.input, limits) }
  }
  if (block.type === 'subagent-group') {
    return {
      ...block,
      agents: block.agents.slice(0, MAX_LEGACY_IMPORT_SUBAGENTS).map((agent) => ({
        ...agent,
        // Digest-based roster IDs keep children with shared prefixes distinct.
        id: boundSubagentEntryId(agent.id),
        label: boundInlineText(agent.label, limits).text
      }))
    }
  }
  return block
}
