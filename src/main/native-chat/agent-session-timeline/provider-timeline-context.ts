import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import type { AgentType } from '../../../shared/agent-status/contracts/agent-status-types'
import type { ProviderTimelineJoin } from './provider-timeline-event'
import { providerKey, type ProviderTimelineRows } from './provider-timeline-rows'
import type { ProviderTimelineState } from './provider-timeline-state'

export type ProviderTimelineContext = {
  sessionId: string
  agent: AgentType
  generation: string
  rows: ProviderTimelineRows
  /** Other provider threads are subagent work. */
  ownThread?: () => string | null
}

export function providerTimelineSettlementId(
  context: ProviderTimelineContext,
  serial: number,
  what: string
): string {
  return `provider-timeline:${context.sessionId}:${context.generation}:${serial}:${what}`
}

/** Prefer the named turn, then open turn; independent subagent threads always join the open turn. */
export function providerTimelinePlacement(
  context: ProviderTimelineContext,
  state: ProviderTimelineState,
  join: ProviderTimelineJoin | undefined
): AgentJournalTurnScope {
  const thread = join?.thread ?? null
  if (join?.turn === undefined) {
    return state.scope
  }
  const own = context.ownThread?.() ?? null
  if (thread !== null && own !== null && thread !== own) {
    return state.scope
  }
  return { kind: 'turn', turnItemId: context.rows.turn(providerKey(join.turn)).itemId }
}
