import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { isAgentSessionContextClear } from '../../../shared/agent-session/agent-session-context-clear'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import {
  namedSubagents,
  subagentFoldKey,
  subagentItemBlock
} from '../../../shared/native-chat/transcript/native-chat-subagent-items'
import {
  HISTORY_PAGE_CONTENT_BUDGET_BYTES,
  isSubagentRow
} from '../agent-session-wire/publication/history/agent-session-history-page-bounds'
import { agentJournalItemForWire } from '../agent-session-wire/publication/history/agent-session-item-wire-form'

/** Facts history selects before decoding a body; written from each current item revision. */
export type JournalDomainHistoryMetadata = {
  root: number
  subagentRow: number
  subagentGroupKey: string | null
  namedSubagentIds: string[]
  turnMarker: number
  /** Client-form bytes when they differ from the stored payload; null reads the stored length. */
  wireBytes: number | null
}

/** Pass the stored payload text when the caller already serialized it. */
export function journalDomainHistoryMetadata(
  item: AgentJournalRenderItem,
  payloadJson?: string
): JournalDomainHistoryMetadata {
  const root = isRootAgentJournalItem(item)
  const block = item.body.kind === 'message' ? subagentItemBlock(item.body) : null
  const named =
    root && item.body.kind === 'message'
      ? item.body.blocks.flatMap(namedSubagents).map((entry) => entry.id)
      : []
  return {
    root: Number(root),
    subagentRow: Number(isSubagentRow(item)),
    subagentGroupKey: block ? subagentFoldKey(block) : null,
    namedSubagentIds: named,
    turnMarker: Number(
      readAgentJournalTurn(item.body) !== null || isAgentSessionContextClear(item.body)
    ),
    wireBytes: wireBytes(item, payloadJson)
  }
}

// The client form cuts tool/diff heads and whole items over the page budget; skipping the
// form elsewhere only overstates a size, which shortens a page but never drops content.
function wireBytes(item: AgentJournalRenderItem, payloadJson: string | undefined): number | null {
  if (
    item.body.kind !== 'tool-call' &&
    item.body.kind !== 'diff' &&
    Buffer.byteLength(payloadJson ?? JSON.stringify(item), 'utf8') <=
      HISTORY_PAGE_CONTENT_BUDGET_BYTES
  ) {
    return null
  }
  const sent = agentJournalItemForWire(item)
  return sent.item === item ? null : sent.bytes
}
