import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import type { QueuedMessageRow } from '../../agent-session-journal/queued-messages/queued-message-table'
import type { StructuredAgentSessionCurrentWork } from '../observations/structured-agent-session-current-work'
import { pendingPromptsAllUnanswerableHere } from '../../../../shared/agent-session/agent-session-approval-subject'
import { orchestrationMailNotice } from '../../../../shared/agent-session/agent-session-message-source'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'

export type StructuredInputSelection =
  | { kind: 'card'; card: QueuedMessageRow }
  | { kind: 'submission'; submission: AgentJournalSubmission }
  | { kind: 'none' }

/** One live checkpoint owns automatic input order; debt alone is not execution. */
export function selectStructuredAgentSessionInput(
  journal: AgentSessionJournal,
  currentInput?: string,
  _unanswerable = false,
  steer = false
): StructuredInputSelection {
  const current = currentInput ? journal.submission(currentInput) : undefined
  const pending =
    journal.inputOrder.firstQueued() ?? (current?.dispatchState === 'pending' ? current : undefined)
  if (pending) {
    return { kind: 'submission', submission: pending }
  }
  const card = journal.queuedMessages.nextInputCard(true, steer)
  return card ? { kind: 'card', card } : { kind: 'none' }
}

export function selectedStructuredSubmission(
  journal: AgentSessionJournal
): AgentJournalSubmission | undefined {
  if (!journal.inputOrder.firstQueued()) {
    return undefined
  }
  const selected = selectStructuredAgentSessionInput(journal)
  return selected.kind === 'submission' ? selected.submission : undefined
}

export function selectableStructuredSubmission(
  journal: AgentSessionJournal,
  work: StructuredAgentSessionCurrentWork | null,
  currentInput?: string
): AgentJournalSubmission | undefined {
  if (!journal.inputOrder.firstQueued() && currentInput === undefined) {
    return undefined
  }
  const unanswerable = work !== null && pendingPromptsAllUnanswerableHere(work.attentionPrompts())
  const selected = selectStructuredAgentSessionInput(journal, currentInput, unanswerable)
  if (selected.kind !== 'submission') {
    return undefined
  }
  const { submission } = selected
  const body = journal.itemBody(agentJournalSubmissionKey(submission.clientMessageId))
  if (
    !unanswerable &&
    submission.origin === 'host' &&
    body?.kind === 'message' &&
    orchestrationMailNotice(body.from) &&
    work &&
    work.attentionPrompts().length > 0
  ) {
    return undefined
  }
  if (unanswerable) {
    return submission
  }
  return submission
}

/** Provider-held/uncertain work still blocks cards; deferred, proven-unhanded inputs do not. */
export function structuredInputExecutionWorking(
  journal: AgentSessionJournal,
  work: StructuredAgentSessionCurrentWork,
  currentInput?: string
): boolean {
  if (work.activeTurnId() !== null) {
    return true
  }
  return structuredInputHandoverWorking(journal, work, currentInput)
}

export function structuredInputHandoverWorking(
  journal: AgentSessionJournal,
  work: StructuredAgentSessionCurrentWork,
  currentInput?: string
): boolean {
  for (const entry of journal.inputOrder.enteredSubmissions()) {
    if (entry.clientMessageId !== currentInput && work.owesSend(entry)) {
      return true
    }
  }
  return false
}
