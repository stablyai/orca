import type {
  AgentJournalProducerLinkage,
  AgentJournalTurnScope,
  AgentType
} from '../../../shared/agent-session-journal-types'
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

/** Budget bodies/linkage plus provider strings twice: raw values and derived identities. */
export function providerTimelineEntryBytes(input: {
  key: string
  join: ProviderTimelineJoin | undefined
  body?: unknown
  producer: AgentJournalProducerLinkage | undefined
}): number {
  const measure = (value: unknown) =>
    value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  const kept = [input.key, input.join?.thread ?? '', input.join?.turn ?? ''].reduce(
    (total, part) => total + Buffer.byteLength(part, 'utf8'),
    0
  )
  return 2 * kept + measure(input.body) + measure(input.producer) + 64
}
