import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import type { QueuedMessageRow } from '../../agent-session-journal/queued-messages/queued-message-table'
import type { StructuredAgentSessionObservedWork } from '../observations/structured-agent-session-observed-work'
import type { JournalWorkReader } from '../../agent-session-journal/journal-work-read'
import { pendingPromptsAllUnanswerableHere } from '../../../../shared/agent-session/agent-session-approval-subject'
import { orchestrationMailNotice } from '../../../../shared/agent-session/agent-session-message-source'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'

export type StructuredInputSelection =
  | { kind: 'card'; card: QueuedMessageRow }
  | { kind: 'submission'; submission: AgentJournalSubmission }
  | { kind: 'none' }

/** One live checkpoint owns automatic input order; debt alone is not execution. */
export async function selectStructuredAgentSessionInput(
  journal: AgentSessionJournal,
  currentInput?: string,
  _unanswerable = false,
  steer = false,
  cards?: readonly QueuedMessageRow[]
): Promise<StructuredInputSelection> {
  const current = currentInput ? await journal.reads.submission(currentInput) : undefined
  const pending =
    (await journal.reads.input({ kind: 'first-queued' })).submission ??
    (current?.dispatchState === 'pending' ? current : undefined)
  if (pending) {
    return { kind: 'submission', submission: pending }
  }
  const card = await journal.queuedMessages.nextInputCard(true, steer, cards)
  return card ? { kind: 'card', card } : { kind: 'none' }
}

export async function selectedStructuredSubmission(
  journal: AgentSessionJournal
): Promise<AgentJournalSubmission | undefined> {
  return (await journal.reads.input({ kind: 'first-queued' })).submission
}

export async function selectableStructuredSubmission(
  journal: AgentSessionJournal,
  work: Pick<
    StructuredAgentSessionObservedWork,
    'actionablePrompts' | 'hasActionablePrompt'
  > | null,
  currentInput?: string
): Promise<AgentJournalSubmission | undefined> {
  const submission =
    (await selectedStructuredSubmission(journal)) ??
    (currentInput ? await journal.reads.submission(currentInput) : undefined)
  if (submission?.dispatchState !== 'pending') {
    return undefined
  }
  const unanswerable = work !== null && pendingPromptsAllUnanswerableHere(work.actionablePrompts())
  const body = await journal.reads.itemBody(agentJournalSubmissionKey(submission.clientMessageId))
  if (
    !unanswerable &&
    submission.origin === 'host' &&
    body?.kind === 'message' &&
    orchestrationMailNotice(body.from) &&
    work?.hasActionablePrompt()
  ) {
    return undefined
  }
  if (unanswerable) {
    return submission
  }
  return submission
}

/** Provider-held/uncertain work still blocks cards; deferred, proven-unhanded inputs do not. */
export async function structuredInputExecutionWorking(
  journal: AgentSessionJournal,
  work: Pick<StructuredAgentSessionObservedWork, 'activeTurnId'>,
  readWork: JournalWorkReader,
  currentInput?: string
): Promise<boolean> {
  return (
    work.activeTurnId() !== null || structuredInputHandoverWorking(journal, readWork, currentInput)
  )
}

export async function structuredInputHandoverWorking(
  _journal: AgentSessionJournal,
  readWork: JournalWorkReader,
  currentInput?: string
): Promise<boolean> {
  const { state } = await readWork({ kind: 'state' })
  return state.owedEnteredSubmissions.some((entry) => entry.clientMessageId !== currentInput)
}
