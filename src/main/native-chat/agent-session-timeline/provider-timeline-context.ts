// What every decision of one assembler shares, and where a joined row goes.

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
  /** The session's own provider thread; a join naming another thread is subagent work. */
  ownThread?: () => string | null
}

/** A settlement id no other settlement of this journal shares. */
export function providerTimelineSettlementId(
  context: ProviderTimelineContext,
  serial: number,
  what: string
): string {
  return `provider-timeline:${context.sessionId}:${context.generation}:${serial}:${what}`
}

/** The turn a new row joins: the one the provider names, else the open one, else none. Subagent
 *  work on a thread of its own joins the open turn whatever turn it names. */
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

/** What an entry the assembler holds open costs: its body, its producer, and every provider
 *  string it keeps (its key and join), each twice: as given, and inside the identities spelled
 *  from it. */
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
