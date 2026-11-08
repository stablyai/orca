// Admission allocates/writes nothing; the writer resolves each write against what has committed,
// because recovery or another writer may land after admission.

import type { StructuredAgentSessionItemAppendOptions } from '../agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import type { ProviderTimelineContext } from './provider-timeline-context'
import type { JournalTimelineItemResolution } from '../agent-session-journal/writing/journal-timeline-resolution'
import type { JournalStepOutcome } from '../agent-session-journal/writing/journal-writer-step'
import type { ProviderTimelineEvent } from './provider-timeline-event'
import {
  decideFrame,
  decideItem,
  decideRequest,
  decideWithdrawal
} from './provider-timeline-item-decisions'
import type { ProviderTimelineTurnRef } from './provider-timeline-rows'
import type { ProviderTimelineState } from './provider-timeline-state'
import type { ProviderTimelineSettlementResolution } from './provider-timeline-writer-resolution'
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
  | 'no-turn'
  | 'item-settled'
  | 'stream-unknown'
  | 'stream-mismatch'

export type ProviderTimelineDecidedEvent =
  | Exclude<ProviderTimelineEvent, { type: 'text.delta' | 'text.close' | 'activity' }>
  /** Another writer settled the turn; cancel text/prompts but leave calls for the provider’s end. */
  | { type: 'turn.settled'; turn: ProviderTimelineTurnRef }

/** Placement is fixed at admission; content resolves at execution. */
export type ProviderTimelineItemWrite = {
  reservedBytes: number
  lifecycle: boolean
  /** Existing rows keep their scope; new rows use admission placement. */
  options: StructuredAgentSessionItemAppendOptions
  onResolved?: (outcome: JournalStepOutcome) => void
  resolution: JournalTimelineItemResolution
}

export type ProviderTimelineDecision = {
  dropped?: ProviderTimelineDropRule
  /** Apply state changes only after sink admission. */
  commit?: (state: ProviderTimelineState) => void
  /** The writer chooses the settlement's mutations at execution. */
  settle?: {
    what: string
    recovered?: true
    resolution: ProviderTimelineSettlementResolution
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
      return decideTurnSettled(input, event)
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
