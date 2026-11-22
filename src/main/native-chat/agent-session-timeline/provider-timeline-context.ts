import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import type { AgentType } from '../../../shared/agent-status/contracts/agent-status-types'
import type { ProviderTimelineJoin } from './provider-timeline-event'
import { providerKey, type ProviderTimelineRows } from './provider-timeline-rows'
import type { ProviderTimelineState } from './provider-timeline-state'
import type { ProviderTimelineRequest } from './provider-timeline-writer-resolution'

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

export function providerTimelineRequest(
  context: ProviderTimelineContext,
  key: string
): ProviderTimelineRequest {
  return { agent: context.agent, sessionId: context.sessionId, generation: context.generation, key }
}

export function providerTimelineScopeItemIds(
  context: ProviderTimelineContext,
  join: ProviderTimelineJoin | undefined
): readonly string[] | undefined {
  return join?.scopeItems?.map(
    (key) => context.rows.item('item', providerKey(key), join.thread ?? null).itemId
  )
}

/** Prefer the named turn, then open turn; independent subagent threads always join the open turn. */
export function providerTimelinePlacement(
  context: ProviderTimelineContext,
  state: ProviderTimelineState,
  join: ProviderTimelineJoin | undefined
): AgentJournalTurnScope {
  const thread = join?.thread ?? null
  if (join?.turn === undefined && join?.scope === undefined) {
    return state.scope
  }
  const own = context.ownThread?.() ?? null
  if (thread !== null && own !== null && thread !== own) {
    return state.scope
  }
  if (join?.scope) {
    return join.scope
  }
  return join?.turn === undefined
    ? state.scope
    : { kind: 'turn', turnItemId: context.rows.turn(providerKey(join.turn)).itemId }
}
