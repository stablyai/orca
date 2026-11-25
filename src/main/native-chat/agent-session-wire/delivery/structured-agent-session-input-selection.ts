import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import type { StructuredAgentSessionObservedWork } from '../observations/structured-agent-session-observed-work'
import { pendingPromptsAllUnanswerableHere } from '../../../../shared/agent-session/requests/prompts/agent-session-approval-subject'
import { orchestrationMailNotice } from '../../../../shared/agent-session/journal/agent-session-message-source'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { isWithheldOpeningMessage } from '../acquisition/structured-agent-session-opening-withdrawal'
import { isQueuedAgentJournalSubmission } from '../../../../shared/agent-session/requests/agent-session-queued-submission'

const unresolvedStarts = new WeakMap<AgentSessionJournal, Set<string>>()

/** A pre-child start failed before handover. Hold that exact send until its durable rejection. */
export function holdUnsettledStart(journal: AgentSessionJournal, id: string): () => void {
  const held = unresolvedStarts.get(journal) ?? new Set<string>()
  held.add(id)
  unresolvedStarts.set(journal, held)
  return () => {
    held.delete(id)
  }
}

export function hasUnsettledStart(journal: AgentSessionJournal, id: string): boolean {
  return unresolvedStarts.get(journal)?.has(id) === true
}

export function unsettledStartIds(journal: AgentSessionJournal): string[] | undefined {
  const held = unresolvedStarts.get(journal)
  return held?.size ? [...held] : undefined
}

export async function selectedStructuredSubmission(
  journal: AgentSessionJournal
): Promise<AgentJournalSubmission | undefined> {
  const first = (await journal.reads.input({ kind: 'first-queued' })).submission
  if (!first || !hasUnsettledStart(journal, first.clientMessageId)) {
    return first
  }
  return (await journal.reads.pendingSubmissions()).find(
    (entry) =>
      isQueuedAgentJournalSubmission(entry) && !hasUnsettledStart(journal, entry.clientMessageId)
  )
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
  if (
    isWithheldOpeningMessage(submission.clientMessageId) ||
    hasUnsettledStart(journal, submission.clientMessageId)
  ) {
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
