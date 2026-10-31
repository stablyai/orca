import type {
  AgentJournalSubmission,
  AgentJournalCursor
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { QueuedMessageRow } from '../agent-session-journal/queued-message-table'
import {
  nextSendableQueuedCard,
  queuePauseHolding
} from '../agent-session-journal/queued-message-pause'
import type { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import { pendingPromptsAllUnanswerableHere } from '../../../shared/agent-session-approval-subject'

export type StructuredInputSelection =
  | { kind: 'card'; card: QueuedMessageRow }
  | { kind: 'submission'; submission: AgentJournalSubmission }
  | { kind: 'none' }

const selections = new WeakMap<
  AgentSessionJournal,
  {
    cards: readonly QueuedMessageRow[]
    revision: number
    editRevision: number
    reopenFloor: AgentJournalCursor | null
    selection: StructuredInputSelection
  }
>()

/** One live checkpoint owns automatic input order; debt alone is not execution. */
export function selectStructuredAgentSessionInput(
  journal: AgentSessionJournal,
  currentInput?: string,
  unanswerable = false
): StructuredInputSelection {
  const cards = journal.queuedMessages.list()
  const revision = journal.inputOrder.version()
  const editRevision = journal.queuedMessages.editLeases.version()
  const reopenFloor = journal.reopenFloor()
  const prior = selections.get(journal)
  if (
    !unanswerable &&
    currentInput === undefined &&
    prior?.cards === cards &&
    prior.revision === revision &&
    prior.editRevision === editRevision &&
    prior.reopenFloor === reopenFloor
  ) {
    return prior.selection
  }
  const pauses = journal.queuedMessages.pauses()
  const edited = journal.queuedMessages.editLeases.heldIds(cards)
  const remember = (selection: StructuredInputSelection): StructuredInputSelection => {
    if (!unanswerable && currentInput === undefined) {
      selections.set(journal, {
        cards,
        revision,
        editRevision: journal.queuedMessages.editLeases.version(),
        reopenFloor,
        selection
      })
    }
    return selection
  }
  const queued = journal.inputOrder.firstQueued()
  const current = currentInput ? journal.submission(currentInput) : undefined
  let selected =
    current?.dispatchState === 'pending' &&
    (!queued || current.submittedSequence! < queued.submittedSequence!)
      ? current
      : queued
  const nextCard = nextSendableQueuedCard(pauses, cards, edited)
  if (!selected) {
    return remember(nextCard ? { kind: 'card', card: nextCard } : { kind: 'none' })
  }
  // Explicit card Send intentionally overrides the automatic queue place.
  const override = journal.inputOrder.explicitSend()
  if (override) {
    return remember({ kind: 'submission', submission: override })
  }
  if (unanswerable) {
    return { kind: 'submission', submission: selected }
  }
  const predecessors = journal.inputOrder.predecessors(
    journal.queuedMessages.displayState(),
    selected.clientMessageId
  )
  const handoff = predecessors.handoff?.consumedAs
  if (handoff) {
    const submission = journal.submission(handoff)
    if (submission) {
      return remember({ kind: 'submission', submission })
    }
  }
  if (predecessors.waiting && !queuePauseHolding(pauses, predecessors.waiting)) {
    return remember(nextCard ? { kind: 'card', card: nextCard } : { kind: 'none' })
  }
  return remember({ kind: 'submission', submission: selected })
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
