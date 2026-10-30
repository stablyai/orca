import { readJournalMailSource } from './journal-mail-boundary'
// Latch handoff outcomes before rewind can retire their rows; requeue only proven-undelivered sends.

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
  revision: number
}

export function createJournalQueueState(): JournalQueueState {
  return { cards: new Map(), revision: 0 }
}

/** Proven non-delivery waits again; uncertainty stays spent; reported command refusals need no returned card. */
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

function commandTurnReported(state: JournalReducerState, clientMessageId: string): boolean {
  return state.items.has(
    agentJournalItemKey(structuredAgentSessionCommandTurnIdentity(clientMessageId))
  )
}

/** Share card classification across replay/import/read; missing handoffs never authorize resending. */
export function queuedCardFromChange(
  state: JournalReducerState,
  messageId: string,
  change: JournalQueuedChange
): QueuedMessageRow {
  const options = readAgentSessionExecutionOptions(change.options)
  const mailSource = readJournalMailSource(change.mailSource)
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
    ...(mailSource ? { mailSource } : {}),
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

/** Late answers from earlier attempts must not move cards already handed off again. */
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

/** Ambiguous delivery remains spent; never requeue it. */
function settleHandOffInDoubt(state: JournalReducerState, clientMessageId: string): void {
  const submission = state.submissions.get(clientMessageId)
  if (submission?.dispatchState === 'rejected' && queuedHandOffOutcome(submission) === 'inDoubt') {
    foldQueuedHandOffInDoubt(state, submission)
  }
}

// Command turns already show their refusal; returned cards would block following work.
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
