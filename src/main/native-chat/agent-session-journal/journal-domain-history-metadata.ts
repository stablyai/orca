import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { isAgentSessionContextClear } from '../../../shared/agent-session/agent-session-context-clear'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import {
  namedSubagents,
  subagentFoldKey,
  subagentItemBlock
} from '../../../shared/native-chat/transcript/native-chat-subagent-items'
import { isSubagentRow } from '../agent-session-wire/publication/history/agent-session-history-page-bounds'

/** Facts history selects before decoding a body; written from each current item revision. */
export type JournalDomainHistoryMetadata = {
  root: number
  subagentRow: number
  subagentGroupKey: string | null
  namedSubagentIds: string | null
  turnMarker: number
}

export function journalDomainHistoryMetadata(
  item: AgentJournalRenderItem
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
    namedSubagentIds: named.length > 0 ? JSON.stringify(named) : null,
    turnMarker: Number(
      readAgentJournalTurn(item.body) !== null || isAgentSessionContextClear(item.body)
    )
  }
}
