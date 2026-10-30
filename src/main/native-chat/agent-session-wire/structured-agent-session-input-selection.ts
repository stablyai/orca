import type {
  AgentJournalSubmission,
  AgentJournalCursor
} from '../../../shared/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
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
    pending: readonly AgentJournalSubmission[]
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
  const owed = journal.inputOrder.unsettledSubmissions()
  const revision = journal.inputOrder.version()
  const editRevision = journal.queuedMessages.editLeases.version()
  const reopenFloor = journal.reopenFloor()
  const prior = selections.get(journal)
  if (
    !unanswerable &&
    currentInput === undefined &&
    prior?.cards === cards &&
    prior.pending === owed &&
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
        pending: owed,
        revision,
        editRevision: journal.queuedMessages.editLeases.version(),
        reopenFloor,
        selection
      })
    }
    return selection
  }
  const pending = owed
    .filter(
      (entry) =>
        isQueuedAgentJournalSubmission(entry) ||
        (entry.clientMessageId === currentInput && entry.dispatchState === 'pending')
    )
    .sort((a, b) => (a.acceptedSequence ?? 0) - (b.acceptedSequence ?? 0))
  const nextCard = nextSendableQueuedCard(pauses, cards, edited)
  let selected = pending[0]
  if (!selected) {
    return remember(nextCard ? { kind: 'card', card: nextCard } : { kind: 'none' })
  }
  // Explicit card Send intentionally overrides the automatic queue place.
  const override = pending.find(
    (entry) => entry.origin === 'client' && entry.queuedMessageId !== undefined
  )
  if (override) {
    return remember({ kind: 'submission', submission: override })
  }
  if (unanswerable) {
    return { kind: 'submission', submission: selected }
  }
  const predecessors = cards.filter((card) => journal.inputOrder.precedes(card, selected))
  const handoffs = new Map<string, AgentJournalSubmission>()
  for (const entry of pending) {
    if (entry.queuedMessageId !== undefined && !handoffs.has(entry.queuedMessageId)) {
      handoffs.set(entry.queuedMessageId, entry)
    }
  }
  for (const card of predecessors) {
    const handoff = handoffs.get(card.messageId)
    if (handoff) {
      selected = handoff
      break
    }
  }
  if (
    selected === pending[0] &&
    predecessors.some(
      (card) =>
        card.state === 'waiting' && card.holdReason === null && !queuePauseHolding(pauses, card)
    )
  ) {
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
  const unanswerable = work !== null && pendingPromptsAllUnanswerableHere(work.actionablePrompts())
  const selected = selectStructuredAgentSessionInput(journal, currentInput, unanswerable)
  if (selected.kind !== 'submission') {
    return undefined
  }
  const { submission } = selected
  if (unanswerable) {
    return submission
  }
  return journal.inputOrder.prefix(submission.clientMessageId).length > 0 &&
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
  return (
    work.activeTurnId() !== null ||
    journal.inputOrder
      .unsettledSubmissions()
      .some(
        (entry) =>
          entry.clientMessageId !== currentInput &&
          !isQueuedAgentJournalSubmission(entry) &&
          work.owesSend(entry)
      )
  )
}
