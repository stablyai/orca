import { finishJournalSteps } from '../agent-session-journal/journal-reconstruction-steps'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { QueuedMessageRow } from '../agent-session-journal/queued-message-table'
import type { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import { pendingPromptsAllUnanswerableHere } from '../../../shared/agent-session/agent-session-approval-subject'
import { orchestrationMailNotice } from '../../../shared/agent-session/agent-session-message-source'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'

export type StructuredInputSelection =
  | { kind: 'card'; card: QueuedMessageRow }
  | { kind: 'submission'; submission: AgentJournalSubmission }
  | { kind: 'none' }

/** Execution resolves only the selected input's legacy receipt demand. */
export function selectStructuredAgentSessionInput(
  journal: AgentSessionJournal,
  currentInput?: string,
  unanswerable = false,
  steer = false
): Promise<StructuredInputSelection> {
  return journal.withInputOrder(
    () =>
      [journal.inputOrder.firstQueued()?.clientMessageId, currentInput].filter(
        (id): id is string => id !== undefined
      ),
    () => selectPublishedStructuredAgentSessionInput(journal, currentInput, unanswerable, steer)
  )
}

/** One live checkpoint owns automatic input order; debt alone is not execution. */
export function selectPublishedStructuredAgentSessionInput(
  journal: AgentSessionJournal,
  currentInput?: string,
  unanswerable = false,
  steer = false
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
    const card = journal.queuedMessages.nextInputCard(true, steer)
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

export async function selectedStructuredSubmission(
  journal: AgentSessionJournal
): Promise<AgentJournalSubmission | undefined> {
  if (!journal.inputOrder.firstQueued()) {
    return undefined
  }
  const selected = await selectStructuredAgentSessionInput(journal)
  return selected.kind === 'submission' ? selected.submission : undefined
}

export async function selectableStructuredSubmission(
  journal: AgentSessionJournal,
  work: StructuredAgentSessionCurrentWork | null,
  currentInput?: string
): Promise<AgentJournalSubmission | undefined> {
  if (!journal.inputOrder.firstQueued() && currentInput === undefined) {
    return undefined
  }
  const unanswerable = work !== null && pendingPromptsAllUnanswerableHere(work.actionablePrompts())
  const selected = await selectStructuredAgentSessionInput(journal, currentInput, unanswerable)
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
    work?.hasActionablePrompt()
  ) {
    return undefined
  }
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
  return structuredInputHandoverWorking(journal, work, currentInput)
}

export function structuredInputHandoverWorking(
  journal: AgentSessionJournal,
  work: StructuredAgentSessionCurrentWork,
  currentInput?: string
): boolean {
  return finishJournalSteps(structuredInputHandoverWorkingSteps(journal, work, currentInput))
}

export function* structuredInputHandoverWorkingSteps(
  journal: AgentSessionJournal,
  work: StructuredAgentSessionCurrentWork,
  currentInput?: string
): Generator<void, boolean> {
  for (const entry of journal.inputOrder.enteredSubmissions()) {
    yield
    if (entry.clientMessageId !== currentInput && work.owesSend(entry)) {
      return true
    }
  }
  return false
}
