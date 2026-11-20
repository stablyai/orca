import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import type { StructuredAgentSessionObservedWork } from '../observations/structured-agent-session-observed-work'
import { pendingPromptsAllUnanswerableHere } from '../../../../shared/agent-session/requests/prompts/agent-session-approval-subject'
import { orchestrationMailNotice } from '../../../../shared/agent-session/journal/agent-session-message-source'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { isWithheldOpeningMessage } from '../acquisition/structured-agent-session-opening-withdrawal'

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
  // Refused by its caller at delivery: never handed over, even if the refusal wasn't saved.
  if (isWithheldOpeningMessage(submission.clientMessageId)) {
    return undefined
  }
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
  return submission
}
