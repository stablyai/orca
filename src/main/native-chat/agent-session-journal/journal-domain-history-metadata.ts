import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { isAgentSessionContextClear } from '../../../shared/agent-session/agent-session-context-clear'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import {
  namedSubagents,
  subagentFoldKey,
  subagentItemBlock
} from '../../../shared/native-chat/transcript/subagents/native-chat-subagent-items'
import { isSubagentRow } from '../agent-session-wire/publication/history/agent-session-history-page-bounds'
import { journalDomainItemWire } from './journal-domain-item-wire'
export { journalDomainItemWire } from './journal-domain-item-wire'

/** Facts history selects before decoding a body; written from each current item revision. */
export type JournalDomainHistoryMetadata = {
  root: number
  subagentRow: number
  subagentGroupKey: string | null
  namedSubagentIds: string[]
  turnMarker: number
  wireVersion: number
  /** Client-form bytes when they differ from the stored payload; null reads the stored length. */
  wireBytes: number | null
  wireJson: string | null
  detailJson: string | null
}

/** Pass the stored payload text when the caller already serialized it. */
export function journalDomainHistoryMetadata(
  item: AgentJournalRenderItem,
  payloadJson?: string,
  displayed = item
): JournalDomainHistoryMetadata {
  const root = isRootAgentJournalItem(item)
  const block = item.body.kind === 'message' ? subagentItemBlock(item.body) : null
  return {
    root: Number(root),
    subagentRow: Number(isSubagentRow(item)),
    subagentGroupKey: block ? subagentFoldKey(block) : null,
    namedSubagentIds: journalDomainNamedSubagentIds(item),
    turnMarker: Number(
      readAgentJournalTurn(item.body) !== null || isAgentSessionContextClear(item.body)
    ),
    ...journalDomainItemWire(item, payloadJson, displayed)
  }
}

export function journalDomainNamedSubagentIds(item: AgentJournalRenderItem): string[] {
  return isRootAgentJournalItem(item) && item.body.kind === 'message'
    ? item.body.blocks.flatMap(namedSubagents).map((entry) => entry.id)
    : []
}
