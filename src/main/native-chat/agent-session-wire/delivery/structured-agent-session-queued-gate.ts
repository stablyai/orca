import { pendingPromptsAllUnanswerableHere } from '../../../../shared/agent-session/agent-session-approval-subject'
import type { StructuredAgentSessionProviderChild } from '../host/structured-agent-session-host-types'
import type { StructuredAgentSessionAdapter } from '../providers/structured-agent-session-adapter'
import { structuredAgentSessionChildAcceptsInput } from './structured-agent-session-input-readiness'
import { codexTurnOptionsDiffer } from '../options/structured-agent-session-message-options'
import type { JournalWorkReader } from '../../agent-session-journal/journal-work-read'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import type { QueuedMessageRow } from '../../agent-session-journal/queued-messages/queued-message-table'
import type { StructuredAgentSessionObservedWork } from '../observations/structured-agent-session-observed-work'
import { structuredAgentSessionSendBlock } from '../operations/structured-agent-session-send-preparation'
import {
  selectStructuredAgentSessionInput,
  structuredInputExecutionWorking,
  structuredInputHandoverWorking
} from './structured-agent-session-input-selection'

/** Host-local gate shared by admission, drain and Send-now; automatic mail steering and Send-now may join active work. */
export type StructuredQueueHold = 'blocked' | 'working' | 'prompt'

/** Ended-generation leftovers must not hold the queue. */
export type StructuredQueueGateInput = {
  record: AgentSessionRecord | null
  work: Pick<
    StructuredAgentSessionObservedWork,
    'working' | 'hasActionablePrompt' | 'actionablePrompts' | 'activeTurnId'
  >
  readWork: JournalWorkReader
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

/** Publish the drain’s live pick; backlog itself never gates a lone draft. */
export async function nextStructuredQueuedMessage(
  input: StructuredQueueGateInput & {
    journal: AgentSessionJournal
    working?: boolean
    steer?: boolean
    canSteer?: (card: QueuedMessageRow) => boolean | Promise<boolean>
  }
): Promise<QueuedMessageRow | null> {
  // Check execution barriers before choosing a card, which can read mail authority.
  const working =
    input.working ??
    (await structuredInputExecutionWorking(input.journal, input.work, input.readWork))
  const steer = working && input.steer === true && input.work.activeTurnId() !== null
  if (
    (working &&
      (!steer || (await structuredInputHandoverWorking(input.journal, input.readWork)))) ||
    !input.record ||
    structuredAgentSessionSendBlock(input.record) ||
    input.work.hasActionablePrompt()
  ) {
    return null
  }
  const selected = await selectStructuredAgentSessionInput(input.journal, undefined, false, steer)
  return selected.kind === 'card' && (!steer || (await input.canSteer?.(selected.card)) === true)
    ? selected.card
    : null
}

/** Queue behind work/actionable backlog; held, Stop-held or returned cards cannot trap a fresh send. */
export async function shouldQueueStructuredAgentSessionSend(
  input: StructuredQueueGateInput & { journal: AgentSessionJournal; fromAgent?: boolean }
): Promise<boolean> {
  const hold = structuredQueueHold(input)
  if (hold === 'blocked') {
    // Return immediate refusal; queueing behind a blocked session would strand the draft.
    return false
  }
  if (!input.fromAgent && pendingPromptsAllUnanswerableHere(input.work.actionablePrompts())) {
    return false
  }
  if (
    hold !== null ||
    (await input.journal.reads.input({ kind: 'first-queued' })).submission !== undefined
  ) {
    return true
  }
  if (input.fromAgent) {
    // Only the person's own send recovers a failed turn; another agent's message waits held with the rest.
    if (await input.journal.queuedMessages.failureHolds()) {
      return true
    }
  }
  // A person's fresh send ignores edit leases. Automatic drain is what stops on them.
  return (await input.journal.queuedMessages.nextInputCard(false)) !== null
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
