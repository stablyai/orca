import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { QueuedMessageRow } from '../agent-session-journal/queued-message-table'
import type { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import { pendingPromptsAllUnanswerableHere } from '../../../shared/agent-session/agent-session-approval-subject'

export type StructuredInputSelection =
  | { kind: 'card'; card: QueuedMessageRow }
  | { kind: 'submission'; submission: AgentJournalSubmission }
  | { kind: 'none' }

/** One live checkpoint owns automatic input order; debt alone is not execution. */
export function selectStructuredAgentSessionInput(
  journal: AgentSessionJournal,
  currentInput?: string,
  unanswerable = false
): StructuredInputSelection {
  const queued = journal.inputOrder.firstQueued()
  const current = currentInput ? journal.submission(currentInput) : undefined
  const selected =
    current?.dispatchState === 'pending' &&
    (!queued || current.submittedSequence! < queued.submittedSequence!)
      ? current
      : queued
  // Read only where a card can be chosen: the queue's rule may ask mail authority.
  const nextCard = (): StructuredInputSelection => {
    const card = journal.queuedMessages.nextInputCard()
    return card ? { kind: 'card', card } : { kind: 'none' }
  }
  if (!selected) {
    return nextCard()
  }
  // Explicit card Send intentionally overrides the automatic queue place.
  const override = journal.inputOrder.explicitSend()
  if (override) {
    return { kind: 'submission', submission: override }
  }
  if (unanswerable) {
    return { kind: 'submission', submission: selected }
  }
  const predecessors = journal.inputOrder.predecessors(
    journal.queuedMessages.inputState(),
    selected.clientMessageId
  )
  const handoff = predecessors.handoff?.consumedAs
  if (handoff) {
    const submission = journal.submission(handoff)
    if (submission) {
      return { kind: 'submission', submission }
    }
  }
  if (predecessors.head) {
    return nextCard()
  }
  return { kind: 'submission', submission: selected }
}

export function selectedStructuredSubmission(
  journal: AgentSessionJournal
): AgentJournalSubmission | undefined {
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
  const unanswerable = work !== null && pendingPromptsAllUnanswerableHere(work.actionablePrompts())
  const selected = selectStructuredAgentSessionInput(journal, currentInput, unanswerable)
  if (selected.kind !== 'submission') {
    return undefined
  }
  const { submission } = selected
  if (unanswerable) {
    return submission
  }
  return journal.inputOrder.forced(submission.clientMessageId) &&
    work &&
    structuredInputExecutionWorking(journal, work, currentInput)
    ? undefined
    : submission
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
  for (const entry of journal.inputOrder.enteredSubmissions()) {
    if (entry.clientMessageId !== currentInput && work.owesSend(entry)) {
      return true
    }
  }
  return false
}
