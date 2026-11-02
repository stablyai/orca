// One subagent's own journal row: its key, its body, and reading it back.
//
// Keyed by the child's own id, so every change and every later run of the child revises the one
// row its spawn created, and a provider process that restarts finds that row by key instead of
// scanning for it.

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

/** Scoped by the journal, which is one session's with one provider. */
export function subagentJournalItemIdentity(id: string): AgentJournalItemIdentity {
  return { provider: 'orca', clientMessageId: `subagent:${boundSubagentEntryId(id)}` }
}

/** The row: the block, and the sentence an older client draws in its place. */
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

/** The child's saved row, read by key; null when none was written. */
export function journaledSubagent(
  journal: { itemBody: (itemId: string) => AgentJournalItemBody | null },
  id: string
): NativeChatSubagentBlock | null {
  const body = journal.itemBody(agentJournalItemKey(subagentJournalItemIdentity(id)))
  return body?.kind === 'message' ? (body.blocks.find(isSubagentBlock) ?? null) : null
}

/** The bound every reader clips a label to. A clip never splits a surrogate pair: a lone one is
 *  malformed in a durable row. */
export function boundSubagentLabel(label: string): string {
  if (label.length <= MAX_SUBAGENT_FIELD_CHARS) {
    return label
  }
  const keep = MAX_SUBAGENT_FIELD_CHARS - 1
  const last = label.charCodeAt(keep - 1)
  return `${label.slice(0, last >= 0xd800 && last <= 0xdbff ? keep - 1 : keep)}…`
}
