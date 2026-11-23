import type { JournalCurrentWorkAuthority } from '../../agent-session-journal/journal-observer-read'
import type { StructuredAgentSessionProviderChild } from '../host/structured-agent-session-host-types'
import type { StructuredAgentSessionAdapter } from '../providers/structured-agent-session-adapter'
import { structuredAgentSessionChildAcceptsInput } from './structured-agent-session-input-readiness'
import { codexTurnOptionsDiffer } from '../options/structured-agent-session-message-options'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  refuse,
  type AgentSessionWireRefusal
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
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
    !card.body.command &&
    !card.body.workTarget &&
    structuredAgentSessionChildAcceptsInput({ ...input, current: true }) &&
    !codexTurnOptionsDiffer(input.record, card.options ?? undefined, input.child, input.adapter)
  )
}

/** Refuse immediate Send-now for commands or targeted messages while a turn is running. */
export function refuseQueuedSendWhileWorking(
  work: Pick<StructuredAgentSessionObservedWork, 'working' | 'activeTurnId' | 'queueState'>,
  body: QueuedMessageRow['body']
): AgentSessionWireRefusal | null {
  if (body.command && work.working()) {
    return {
      code: 'agent_session_operation_invalid',
      message: "A command can't be sent while the agent is working."
    }
  }
  if (
    body.workTarget &&
    (work.working() ||
      work.activeTurnId() !== null ||
      work.queueState().owedEnteredSubmissions.length > 0)
  ) {
    return refuse(
      'agent_session_operation_invalid',
      { reason: 'turnActive' },
      'A targeted message opens a new turn and cannot steer a running turn. Wait for the current turn to finish.'
    )
  }
  return null
}
