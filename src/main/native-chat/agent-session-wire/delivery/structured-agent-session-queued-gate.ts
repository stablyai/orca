import type { JournalCurrentWorkAuthority } from '../../agent-session-journal/journal-observer-read'
import type { StructuredAgentSessionProviderChild } from '../host/structured-agent-session-host-types'
import type { StructuredAgentSessionAdapter } from '../providers/structured-agent-session-adapter'
import { structuredAgentSessionChildAcceptsInput } from './structured-agent-session-input-readiness'
import { codexTurnOptionsDiffer } from '../options/structured-agent-session-message-options'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import type { QueuedMessageRow } from '../../agent-session-journal/queued-messages/queued-message-table'
import type { StructuredAgentSessionObservedWork } from '../observations/structured-agent-session-observed-work'
import { structuredAgentSessionSendBlock } from '../operations/structured-agent-session-send-preparation'

/** Host-local gate shared by admission, drain and Send-now; automatic mail steering and Send-now may join active work. */
export type StructuredQueueHold = 'blocked' | 'working' | 'prompt'

/** Ended-generation leftovers must not hold the queue. */
export type StructuredQueueGateInput = {
  authority: JournalCurrentWorkAuthority
  record: AgentSessionRecord | null
  work: Pick<
    StructuredAgentSessionObservedWork,
    'working' | 'hasActionablePrompt' | 'actionablePrompts' | 'activeTurnId'
  >
}

export function structuredQueueHold(
  input: Pick<StructuredQueueGateInput, 'record' | 'work'>
): StructuredQueueHold | null {
  if (!input.record || structuredAgentSessionSendBlock(input.record)) {
    return 'blocked'
  }
  // Prompts outrank working because Send-now cannot override them.
  if (input.work.hasActionablePrompt()) {
    return 'prompt'
  }
  return input.work.working() ? 'working' : null
}

/** Publication uses the same SQL barriers and ordered selector as the writer claim. */
export async function nextStructuredQueuedMessage(
  input: StructuredQueueGateInput & {
    journal: AgentSessionJournal
    cards?: readonly QueuedMessageRow[]
    steer?: boolean
    canSteer?: (card: QueuedMessageRow) => boolean | Promise<boolean>
  }
): Promise<QueuedMessageRow | null> {
  const card = await input.journal.queuedMessages.eligibleInputCard(
    input.authority,
    input.steer === true,
    input.cards
  )
  return card && (input.work.activeTurnId() === null || (await input.canSteer?.(card)) === true)
    ? card
    : null
}

export function canSteerStructuredQueuedMessage(
  input: {
    record: AgentSessionRecord | null
    work: Pick<StructuredAgentSessionObservedWork, 'activeTurnId' | 'activeTurn'> | null
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
