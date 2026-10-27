// Child IDs key reusable rows so later runs revise them directly instead of duplicating or scanning.

import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import { subagentFallbackText } from '../../../shared/native-chat-subagent-items'
import { MAX_SUBAGENT_FIELD_CHARS } from '../../../shared/native-chat-subagent-summary'
import { isSubagentBlock, type NativeChatSubagentBlock } from '../../../shared/native-chat-types'
import { boundSubagentEntryId } from '../subagent-entry-id-bounds'

export function subagentJournalItemIdentity(id: string): AgentJournalItemIdentity {
  return { provider: 'orca', clientMessageId: `subagent:${boundSubagentEntryId(id)}` }
}

/** Include a plain-text fallback for older clients. */
export function subagentJournalBody(block: NativeChatSubagentBlock): AgentJournalMessageItem {
  const bounded: NativeChatSubagentBlock = {
    ...block,
    id: boundSubagentEntryId(block.id),
    label: boundSubagentLabel(block.label),
    groupId: boundSubagentEntryId(block.groupId),
    ...(block.parentId !== undefined ? { parentId: boundSubagentEntryId(block.parentId) } : {}),
    ...(block.run !== undefined ? { run: boundSubagentEntryId(block.run) } : {})
  }
  return {
    kind: 'message',
    role: 'system',
    blocks: [{ type: 'text', text: subagentFallbackText(bounded) }, bounded]
  }
}

export function journaledSubagent(
  journal: { itemBody: (itemId: string) => AgentJournalItemBody | null },
  id: string
): NativeChatSubagentBlock | null {
  const body = journal.itemBody(agentJournalItemKey(subagentJournalItemIdentity(id)))
  return body?.kind === 'message' ? (body.blocks.find(isSubagentBlock) ?? null) : null
}

/** Preserve surrogate pairs: lone surrogates make durable rows malformed. */
export function boundSubagentLabel(label: string): string {
  if (label.length <= MAX_SUBAGENT_FIELD_CHARS) {
    return label
  }
  const keep = MAX_SUBAGENT_FIELD_CHARS - 1
  const last = label.charCodeAt(keep - 1)
  return `${label.slice(0, last >= 0xd800 && last <= 0xdbff ? keep - 1 : keep)}…`
}
