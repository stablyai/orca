import { isDeepStrictEqual } from 'node:util'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalMessageItem,
  type AgentJournalRenderItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import type { JournalResolvedItem } from './journal-item-appender'
import { requiresTerminalSettlement } from '../item-lifecycle/journal-terminal-settlement'
import { relightsProviderTimelineBackgroundTask } from '../../agent-session-timeline/provider-timeline-background-tasks'

export type JournalTimelineItemResolution =
  | { kind: 'text-snapshot'; identity: AgentJournalItemIdentity; body: AgentJournalMessageItem }
  | {
      kind: 'guarded-item'
      identity: AgentJournalItemIdentity
      body: AgentJournalItemBody
      change: 'open' | 'update' | 'close'
    }
  | { kind: 'literal'; identity: AgentJournalItemIdentity; body: AgentJournalItemBody }

export type JournalTimelineItemResult =
  | { kind: 'resolved'; item: JournalResolvedItem }
  | { kind: 'dropped'; reason: 'turn-settled'; turnItemId: string }
  | { kind: 'dropped'; reason: 'item-settled' }

/** The persisted scope wins over the placement captured when the stream was admitted. */
export function resolveJournalTimelineItem(
  item: (itemId: string) => AgentJournalRenderItem | null,
  resolution: JournalTimelineItemResolution,
  placement: AgentJournalTurnScope
): JournalTimelineItemResult {
  if (resolution.kind === 'literal') {
    return { kind: 'resolved', item: { identity: resolution.identity, body: resolution.body } }
  }
  const held = item(agentJournalItemKey(resolution.identity))
  const scope = held ? (held.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE) : placement
  if (resolution.kind === 'guarded-item') {
    if (
      (held?.body.kind === 'tool-call' &&
        held.body.state !== 'running' &&
        (resolution.change === 'close' || !isDeepStrictEqual(held.body, resolution.body))) ||
      relightsProviderTimelineBackgroundTask(held?.body ?? null, resolution.body)
    ) {
      return { kind: 'dropped', reason: 'item-settled' }
    }
    if (
      !requiresTerminalSettlement(resolution.body) ||
      (held && requiresTerminalSettlement(held.body))
    ) {
      return { kind: 'resolved', item: { identity: resolution.identity, body: resolution.body } }
    }
  }
  if (scope.kind === 'turn') {
    const turn = readAgentJournalTurn(item(scope.turnItemId)?.body)
    if (turn && turn.state !== 'running') {
      return { kind: 'dropped', reason: 'turn-settled', turnItemId: scope.turnItemId }
    }
  }
  return { kind: 'resolved', item: { identity: resolution.identity, body: resolution.body } }
}
