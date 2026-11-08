import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem,
  type AgentJournalRenderItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import type { JournalResolvedItem } from './journal-item-appender'

export type JournalTimelineItemResolution = {
  kind: 'text-snapshot'
  identity: AgentJournalItemIdentity
  body: AgentJournalMessageItem
}

export type JournalTimelineItemResult =
  | { kind: 'resolved'; item: JournalResolvedItem }
  | { kind: 'dropped'; reason: 'turn-settled'; turnItemId: string }

/** The persisted scope wins over the placement captured when the stream was admitted. */
export function resolveJournalTimelineItem(
  item: (itemId: string) => AgentJournalRenderItem | null,
  resolution: JournalTimelineItemResolution,
  placement: AgentJournalTurnScope
): JournalTimelineItemResult {
  const held = item(agentJournalItemKey(resolution.identity))
  const scope = held ? (held.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE) : placement
  if (scope.kind === 'turn') {
    const turn = readAgentJournalTurn(item(scope.turnItemId)?.body)
    if (turn && turn.state !== 'running') {
      return { kind: 'dropped', reason: 'turn-settled', turnItemId: scope.turnItemId }
    }
  }
  return { kind: 'resolved', item: { identity: resolution.identity, body: resolution.body } }
}
