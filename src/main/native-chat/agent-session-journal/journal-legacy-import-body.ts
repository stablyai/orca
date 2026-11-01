import type { AgentJournalItemIdentity } from '../../../shared/agent-session-journal-identity'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatMessage } from '../../../shared/native-chat/native-chat-types'
import type { JournalReplacementItem } from './journal-epoch-replacement'
import {
  boundLegacyImportBlock,
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
    blocks: limits
      ? message.blocks.map((block) => boundLegacyImportBlock(block, limits))
      : message.blocks
  }
}
