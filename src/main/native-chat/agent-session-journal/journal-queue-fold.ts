// The queue's fold: each card as the chat's own rows say it stands. A card's outcome is decided by
// the row that decides it (its hand-off's dispatch row) and kept from then on, so a later rewind
// that retires the hand-off cannot change it, and replay reads the same. A hand-off ends the card's
// queue life: it waits again only where Orca proves the agent never got it.

import type {
  AgentJournalCursor,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { readAgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'
import { structuredAgentSessionCommandTurnIdentity } from '../../../shared/structured-agent-session-command-turn-identity'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { readStoredRejectionFact } from './journal-dispatch-reducer'
import { queuedHandOffOutcome } from './journal-dispatch-settlement'
import type { JournalQueueRow, JournalQueuedChange } from './journal-queue-events'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import { foldQueuedHandOffInDoubt } from './journal-submission-fold'
import type { QueuedMessageRow } from './queued-message-table'

export type JournalQueueState = {
  cards: Map<string, QueuedMessageRow>
  /** Moves with every card change, so a reader's memo recomputes only when it must. */
  revision: number
}

export function createJournalQueueState(): JournalQueueState {
  return { cards: new Map(), revision: 0 }
}

/**
 * What a refusal makes of the dispatched card it handed off (`queuedHandOffOutcome`): one Orca
 * proves never reached the agent waits again at its own position under the queue's pause; one that
 * may have reached it stays spent; a failure returns the card with its reason, except a command
 * refused in its own turn, which is spent because that turn's row says why and a returned card
 * would hold every card behind it.
 */
export function rejectedCardTransition(
  card: QueuedMessageRow,
  rejected: AgentJournalSubmission,
  commandTurnReported: boolean
): QueuedMessageRow {
  const outcome = queuedHandOffOutcome(rejected)
  if (outcome === 'waiting') {
    return { ...card, state: 'waiting', holdReason: null, consumedAs: null }
  }
  if (outcome === 'inDoubt') {
    return card
  }
  if (card.body.command && commandTurnReported) {
    return { ...card, state: 'withdrawn' }
  }
  return {
    ...card,
    state: 'returned',
    returnedReason: rejected.reason,
    returnedRejection: rejected.rejection ?? null
  }
}

/** The submission's command turn is in the journal: its own row reports the refusal. */
function commandTurnReported(state: JournalReducerState, clientMessageId: string): boolean {
  return state.items.has(
    agentJournalItemKey(structuredAgentSessionCommandTurnIdentity(clientMessageId))
  )
}

/**
 * THE classification of a `queued` change, for the fold, the import and the read of a card not yet
 * imported, so each reads a card exactly as the others do. Its hand-off still in this epoch settles
 * it as that hand-off's answer does; gone, the saved refusal returns it, and with none it is a
 * hand-off nothing can answer: hidden, never resent and never shown as refused. Pure: the fold
 * settles a hand-off in doubt afterwards (`settleHandOffInDoubt`).
 */
export function queuedCardFromChange(
  state: JournalReducerState,
  messageId: string,
  change: JournalQueuedChange
): QueuedMessageRow {
  const options = readAgentSessionExecutionOptions(change.options)
  const card: QueuedMessageRow = {
    messageId,
    position: change.position,
    body: change.body,
    fingerprint: agentSessionSendBodyFingerprint(state.sessionId, change.body),
    state: 'waiting',
    holdReason: typeof change.holdReason === 'string' ? change.holdReason : null,
    returnedReason: null,
    returnedRejection: null,
    consumedAs: null,
    queuedAt: readQueuedAt(change.queuedAt),
    ...(options ? { options } : {})
  }
  const attempt =
    typeof change.attempt === 'string' && change.attempt.length > 0 ? change.attempt : null
  const submission = attempt === null ? undefined : state.submissions.get(attempt)
  if (submission) {
    const handedOff: QueuedMessageRow = {
      ...card,
      state: 'dispatched',
      holdReason: null,
      consumedAs: attempt
    }
    return settledHandOff(state, handedOff, submission)
  }
  const { returned } = change
  if (typeof returned === 'object' && returned !== null) {
    return {
      ...card,
      state: 'returned',
      holdReason: null,
      consumedAs: attempt,
      returnedReason: typeof returned.reason === 'string' ? returned.reason : null,
      returnedRejection: readStoredRejectionFact(returned.rejection) ?? null
    }
  }
  if (attempt !== null) {
    return { ...card, state: 'dispatched', holdReason: null, consumedAs: attempt }
  }
  return card
}

/** After any row applies: what it does to the cards. */
export function foldJournalQueueRow(state: JournalReducerState, row: JournalRow): void {
  if (row.kind === 'queue') {
    applyQueueRow(state, row)
  } else if (row.kind === 'submission') {
    const card =
      typeof row.queuedMessageId === 'string'
        ? state.queue.cards.get(row.queuedMessageId)
        : undefined
    if (card) {
      setCard(state, {
        ...card,
        state: 'dispatched',
        holdReason: null,
        consumedAs: row.clientMessageId,
        returnedReason: null,
        returnedRejection: null
      })
    }
  } else if (row.kind === 'dispatch') {
    const submission = state.submissions.get(row.clientMessageId)
    const card = cardHandedOffAs(state, submission)
    if (card && submission) {
      setCard(state, settledHandOff(state, card, submission))
      settleHandOffInDoubt(state, row.clientMessageId)
    }
  } else if (row.kind === 'item' || row.kind === 'lifecycle-batch') {
    spendReportedCommandCards(state)
  }
}

function applyQueueRow(state: JournalReducerState, row: JournalQueueRow): void {
  const { change } = row
  if (change.op === 'queued') {
    const card = queuedCardFromChange(state, row.messageId, change)
    setCard(state, card)
    if (card.consumedAs !== null) {
      settleHandOffInDoubt(state, card.consumedAs)
    }
    return
  }
  const card = state.queue.cards.get(row.messageId)
  if (!card) {
    return
  }
  if (change.op === 'edited') {
    const fingerprint = agentSessionSendBodyFingerprint(state.sessionId, change.body)
    setCard(state, { ...card, body: change.body, fingerprint })
  } else if (change.op === 'moved') {
    setCard(state, { ...card, position: change.position })
  } else if (change.op === 'held') {
    setCard(state, card.state === 'waiting' ? { ...card, holdReason: change.holdReason } : card)
  } else if (change.op === 'withdrawn') {
    setCard(state, { ...card, state: 'withdrawn', holdReason: null })
  }
}

/** The card handed off as this submission, while that is still its current hand-off: an older
 *  attempt's late answer never moves a newer one. */
function cardHandedOffAs(
  state: JournalReducerState,
  submission: AgentJournalSubmission | undefined
): QueuedMessageRow | undefined {
  const card =
    submission?.queuedMessageId === undefined
      ? undefined
      : state.queue.cards.get(submission.queuedMessageId)
  return card?.state === 'dispatched' && card.consumedAs === submission?.clientMessageId
    ? card
    : undefined
}

function settledHandOff(
  state: JournalReducerState,
  card: QueuedMessageRow,
  submission: AgentJournalSubmission
): QueuedMessageRow {
  if (submission.dispatchState !== 'rejected') {
    return card
  }
  const reported = commandTurnReported(state, submission.clientMessageId)
  return rejectedCardTransition(card, submission, reported)
}

/** The card's own hand-off, refused while it may have reached the agent: read as sent
 *  (`foldQueuedHandOffInDoubt`). */
function settleHandOffInDoubt(state: JournalReducerState, clientMessageId: string): void {
  const submission = state.submissions.get(clientMessageId)
  if (submission?.dispatchState === 'rejected' && queuedHandOffOutcome(submission) === 'inDoubt') {
    foldQueuedHandOffInDoubt(state, submission)
  }
}

/** A returned command card is spent once its own turn's row reports the refusal. */
function spendReportedCommandCards(state: JournalReducerState): void {
  for (const card of state.queue.cards.values()) {
    if (
      card.state === 'returned' &&
      card.body.command &&
      card.consumedAs !== null &&
      commandTurnReported(state, card.consumedAs)
    ) {
      setCard(state, { ...card, state: 'withdrawn' })
    }
  }
}

function setCard(state: JournalReducerState, card: QueuedMessageRow): void {
  if (state.queue.cards.get(card.messageId) !== card) {
    state.queue.cards.set(card.messageId, card)
    state.queue.revision += 1
  }
}

function readQueuedAt(value: unknown): AgentJournalCursor | null {
  return typeof value === 'object' &&
    value !== null &&
    'epoch' in value &&
    typeof value.epoch === 'string' &&
    'sequence' in value &&
    typeof value.sequence === 'number'
    ? { epoch: value.epoch, sequence: value.sequence }
    : null
}
