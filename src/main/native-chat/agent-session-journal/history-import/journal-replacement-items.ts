import type * as ids from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import type { JournalReplacementItem } from '../context-epochs/journal-epoch-replacement'
import {
  boundLegacyImportBlock,
  boundToolInput,
  type JournalPayloadLimits
} from '../item-lifecycle/journal-payload-bounds'

// Imported history as journal items: the body each decoded message becomes, outside any generation.

export function replacementItems(
  messages: readonly NativeChatMessage[],
  identities: readonly ids.AgentJournalItemIdentity[],
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
  identity: ids.AgentJournalItemIdentity,
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
