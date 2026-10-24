// Admission allocates/writes nothing; deferred resolvers read current journal state because recovery
// may land after admission but before sink binding.

import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import type { StructuredAgentSessionItemAppendOptions } from '../agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionTransitionJournal } from '../agent-session-wire/structured-agent-session-transition'
import type { ProviderTimelineHold } from './provider-timeline-budget'
import type { ProviderTimelineContext } from './provider-timeline-context'
import type { ProviderTimelineEvent } from './provider-timeline-event'
import {
  decideFrame,
  decideItem,
  decideRequest,
  decideWithdrawal
} from './provider-timeline-item-decisions'
import type { ProviderTimelineTurnRef } from './provider-timeline-rows'
import type { ProviderTimelineState } from './provider-timeline-state'
import {
  decideContextUsage,
  decideInput,
  decideSessionEnd,
  decideTurnEnd,
  decideTurnOpen,
  decideTurnSettled
} from './provider-timeline-turn-decisions'

export type ProviderTimelineDropRule =
  | 'session-ended'
  | 'turn-duplicate'
  | 'turn-settled'
  | 'turn-unknown'
  | 'no-turn'
  | 'item-settled'
  | 'request-duplicate'
  | 'request-unknown'
  | 'stream-unknown'
  | 'stream-mismatch'

export type ProviderTimelineDecidedEvent =
  | Exclude<ProviderTimelineEvent, { type: 'text.delta' | 'text.close' | 'activity' }>
  /** Another writer settled the turn; cancel text/prompts but leave calls for the provider’s end. */
  | { type: 'turn.settled'; turn: ProviderTimelineTurnRef }

type Journal = StructuredAgentSessionTransitionJournal

export type ProviderTimelineResolvedWrite = {
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
}

/** Placement is fixed at admission; content resolves at execution. */
export type ProviderTimelineItemWrite = {
  reservedBytes: number
  lifecycle: boolean
  /** Existing rows keep their scope; new rows use admission placement. */
  options: StructuredAgentSessionItemAppendOptions
  resolve: (journal: Journal) => ProviderTimelineResolvedWrite | null
}

export type ProviderTimelineDecision = {
  dropped?: ProviderTimelineDropRule
  hold?: ProviderTimelineHold
  /** Apply state changes only after sink admission. */
  commit?: (state: ProviderTimelineState) => void
  /** Resolve settlement from the journal at execution. */
  settle?: {
    what: string
    recovered?: true
    resolve: (journal: Journal) => readonly JournalLifecycleMutationInput[]
  }
  writes?: readonly ProviderTimelineItemWrite[]
  /** Replace this stream with the event’s full snapshot. */
  closes?: string
  /** Earlier turn ends must not disturb the open turn’s text/activity. */
  ends?: { turnItemId: string; current: boolean }
}

export type ProviderTimelineDecisionInput = {
  context: ProviderTimelineContext
  state: ProviderTimelineState
  /** Null until sink binding. */
  journal: Journal | null
  /** Consume serials only on admission. */
  serial: () => number
}

export function decideProviderTimelineEvent(
  input: ProviderTimelineDecisionInput,
  event: ProviderTimelineDecidedEvent
): ProviderTimelineDecision {
  if (input.state.ended) {
    return { dropped: 'session-ended' }
  }
  switch (event.type) {
    case 'input.accepted':
      return decideInput(input, event)
    case 'turn.open':
      return decideTurnOpen(input, event)
    case 'turn.end':
      return decideTurnEnd(input, event)
    case 'turn.settled':
      return decideTurnSettled(event)
    case 'item.open':
    case 'item.update':
    case 'item.close':
      return decideItem(input, event)
    case 'request.open':
      return decideRequest(input, event)
    case 'request.withdrawn':
      return decideWithdrawal(input, event)
    case 'context.usage':
      return decideContextUsage(input, event)
    case 'provider.frame':
      return decideFrame(input, event)
    case 'session.ended':
      return decideSessionEnd(input, event)
  }
}
