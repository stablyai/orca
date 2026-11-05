import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { structuredAgentSessionChildAcceptsInput } from './structured-agent-session-input-readiness'
import { codexTurnOptionsDiffer } from './structured-agent-session-message-options'
import { journalInputOrder } from '../agent-session-journal/journal-input-order'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { QueuedMessageRow } from '../agent-session-journal/queued-message-table'
import type { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import { structuredAgentSessionSendBlock } from './structured-agent-session-send-preparation'
import {
  selectPublishedStructuredAgentSessionInput,
  structuredInputExecutionWorking,
  structuredInputHandoverWorking
} from './structured-agent-session-input-selection'

/** Host-local gate shared by admission, drain and Send-now; automatic mail steering and Send-now may join active work. */
export type StructuredQueueHold = 'blocked' | 'working' | 'prompt'

/** Ended-generation leftovers must not hold the queue. */
export type StructuredQueueGateInput = {
  record: AgentSessionRecord | null
  work: StructuredAgentSessionCurrentWork
}

export function structuredQueueHold(input: StructuredQueueGateInput): StructuredQueueHold | null {
  if (!input.record || structuredAgentSessionSendBlock(input.record)) {
    return 'blocked'
  }
  // Prompts outrank working because Send-now cannot override them.
  if (input.work.hasActionablePrompt()) {
    return 'prompt'
  }
  return input.work.working() ? 'working' : null
}

/** Publish the drain’s live pick; backlog itself never gates a lone draft. */
export function nextStructuredQueuedMessage(
  input: StructuredQueueGateInput & {
    journal: AgentSessionJournal
    working?: boolean
    steer?: boolean
    canSteer?: (card: QueuedMessageRow) => boolean
  }
): QueuedMessageRow | null {
  // Check execution barriers before choosing a card, which can read mail authority.
  const state = input.journal.queuedMessages.inputState()
  const cards = journalInputOrder(state).cards
  cards.ensure(state)
  if (!cards.head()) {
    return null
  }
  const working = input.working ?? structuredInputExecutionWorking(input.journal, input.work)
  const steer = working && input.steer === true && input.work.activeTurnId() !== null
  if (
    (working && (!steer || structuredInputHandoverWorking(input.journal, input.work))) ||
    !input.record ||
    structuredAgentSessionSendBlock(input.record) ||
    input.work.hasActionablePrompt()
  ) {
    return null
  }
  const selected = selectPublishedStructuredAgentSessionInput(
    input.journal,
    undefined,
    false,
    steer
  )
  return selected.kind === 'card' && (!steer || input.canSteer?.(selected.card) === true)
    ? selected.card
    : null
}

/** Queue behind work/actionable backlog; held, Stop-held or returned cards cannot trap a fresh send. */
export function shouldQueueStructuredAgentSessionSend(
  input: StructuredQueueGateInput & { journal: AgentSessionJournal; fromAgent?: boolean }
): boolean {
  const hold = structuredQueueHold(input)
  if (hold === 'blocked') {
    // Return immediate refusal; queueing behind a blocked session would strand the draft.
    return false
  }
  if (hold !== null) {
    return true
  }
  if (input.fromAgent) {
    // Only the person's own send recovers a failed turn; another agent's message waits held with the rest.
    const state = input.journal.queuedMessages.inputState()
    const cards = journalInputOrder(state).cards
    cards.ensure(state)
    if (cards.failureHolds()) {
      return true
    }
  }
  // A person's fresh send ignores edit leases. Automatic drain is what stops on them.
  return input.journal.queuedMessages.nextInputCard(false) !== null
}

export function canSteerStructuredQueuedMessage(
  input: {
    record: AgentSessionRecord | null
    work: StructuredAgentSessionCurrentWork | null
    child: StructuredAgentSessionProviderChild | null | undefined
    stopping: boolean
    adapter: StructuredAgentSessionAdapter
  },
  card: QueuedMessageRow
): boolean {
  return Boolean(
    input.record &&
    input.work &&
    input.child &&
    structuredAgentSessionChildAcceptsInput({ ...input, current: true }) &&
    !codexTurnOptionsDiffer(input.record, card.options ?? undefined, input.child, input.adapter)
  )
}
