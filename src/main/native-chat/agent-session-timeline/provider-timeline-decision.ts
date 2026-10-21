// What a non-text event does, in two parts that never share a clock.
//
// Admission decides from the state (and the journal's rows by key, when bound) whether the event
// is dropped, what it holds open, and how it changes the state; it writes and allocates nothing.
// Each write's resolver decides, when the write runs, what the journal holds then: a resume admits
// events before the sink binds, and the dead-generation sweep lands between admission and the
// write, so every journal-dependent choice is made there.

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

/** Why an event wrote nothing. Each is a grammar rule the adapter broke or a fact already held. */
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
  /** The assembler's own: the journal shows the open turn settled by another writer (a person's
   *  Stop), so its text stops and its prompts are cancelled; its running tool calls wait for the
   *  provider's own `turn.end`. */
  | { type: 'turn.settled'; turn: ProviderTimelineTurnRef }

type Journal = StructuredAgentSessionTransitionJournal

export type ProviderTimelineResolvedWrite = {
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
}

/** One row write: where it goes is fixed at admission, what it says is resolved when it runs. */
export type ProviderTimelineItemWrite = {
  reservedBytes: number
  lifecycle: boolean
  /** A new row's turn is admission's placement; an existing row keeps its own. */
  options: StructuredAgentSessionItemAppendOptions
  resolve: (journal: Journal) => ProviderTimelineResolvedWrite | null
}

export type ProviderTimelineDecision = {
  dropped?: ProviderTimelineDropRule
  /** What the event holds open, for the budget. */
  hold?: ProviderTimelineHold
  /** The event's change to the state, made when the sink admits it. */
  commit?: (state: ProviderTimelineState) => void
  /** The settlement the event owes, read from the journal when it runs. */
  settle?: {
    what: string
    recovered?: true
    resolve: (journal: Journal) => readonly JournalLifecycleMutationInput[]
  }
  writes?: readonly ProviderTimelineItemWrite[]
  /** The streamed item whose text this event's full snapshot replaces. */
  closes?: string
  /** The turn this event ends; `current` unless another turn is open, whose text and activity
   *  an earlier turn's end leaves alone. */
  ends?: { turnItemId: string; current: boolean }
}

export type ProviderTimelineDecisionInput = {
  context: ProviderTimelineContext
  state: ProviderTimelineState
  /** The journal at admission; null before the sink binds. */
  journal: Journal | null
  /** Serials this event takes, committed with it. */
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
