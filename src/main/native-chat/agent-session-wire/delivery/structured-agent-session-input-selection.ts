import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import type { StructuredAgentSessionObservedWork } from '../observations/structured-agent-session-observed-work'
import { pendingPromptsAllUnanswerableHere } from '../../../../shared/agent-session/requests/prompts/agent-session-approval-subject'
import { orchestrationMailNotice } from '../../../../shared/agent-session/journal/agent-session-message-source'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { isWithheldOpeningMessage } from '../acquisition/structured-agent-session-opening-withdrawal'
import { isQueuedAgentJournalSubmission } from '../../../../shared/agent-session/requests/agent-session-queued-submission'

type StartSettlement = () => Promise<boolean>

const unresolvedStarts = new WeakMap<AgentSessionJournal, Map<string, StartSettlement>>()

/** Hold the exact send until its rejection is durable; a later explicit send can retry the write. */
export function holdUnsettledStart(
  journal: AgentSessionJournal,
  id: string,
  recordRejection: StartSettlement
): StartSettlement {
  const held = unresolvedStarts.get(journal) ?? new Map<string, StartSettlement>()
  const settle = async () => {
    if (held.get(id) !== settle || !(await recordRejection()) || held.get(id) !== settle) {
      return false
    }
    held.delete(id)
    return true
  }
  held.set(id, settle)
  unresolvedStarts.set(journal, held)
  return settle
}

export async function retryUnsettledStarts(
  journal: AgentSessionJournal,
  onError: (error: unknown) => void
): Promise<void> {
  const held = unresolvedStarts.get(journal)
  if (held) {
    for (const settle of held.values()) {
      await settle().catch(onError)
    }
  }
}

export function hasUnsettledStart(journal: AgentSessionJournal, id: string): boolean {
  return unresolvedStarts.get(journal)?.has(id) === true
}

export function unsettledStartIds(journal: AgentSessionJournal): string[] | undefined {
  const held = unresolvedStarts.get(journal)
  return held?.size ? [...held.keys()] : undefined
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
