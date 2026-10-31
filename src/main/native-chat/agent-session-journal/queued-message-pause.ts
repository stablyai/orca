// Derive pauses from journal state: personal Stop, cleared IDs and cards predating reopen.
// Later accepted turns/Resume lift pauses; per-card holds still require their own action.

import type {
  AgentJournalCursor,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import type { JournalStopEvent, JournalTombstoneRow } from './journal-row-schema'

export type QueuePauseReason = 'stopped' | 'cleared' | 'restarted'

/** Memory-only unnamed Stop binding; failedOn affects display, never cancellation ownership. */
export type JournalStopSettle = {
  settling: boolean
  turnId?: string
  failedOn?: JournalStopFailedOn
}

export type JournalStopFailedOn = { turnId: string } | { openedAfter: number }

export type JournalQueuePauseMarks = {
  cleared?: { sequence: number; operationId: string; messageIds: readonly string[]; lifted?: true }
  latestStop: { sequence: number; event: JournalStopEvent; settle?: JournalStopSettle } | null
  /** Zero means absent. */
  resumedSequence: number
  /** Zero means absent. */
  reopenedSequence: number
}

export type DerivedQueuePause = {
  reason: QueuePauseReason
  /** Clear holds exact IDs; other pauses use the cursor boundary. */
  since: AgentJournalCursor | null
  messageIds?: readonly string[]
}

type QueueCard = {
  recovers?: string
  messageId?: string
  state: string
  holdReason: string | null
  queuedAt: AgentJournalCursor | null
}

export function createJournalQueuePauseMarks(): JournalQueuePauseMarks {
  return { latestStop: null, resumedSequence: 0, reopenedSequence: 0 }
}

function isReadableStopEvent(value: unknown): value is JournalStopEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'reason' in value &&
    typeof value.reason === 'string' &&
    'at' in value &&
    typeof value.at === 'number' &&
    Number.isFinite(value.at)
  )
}

export function foldJournalQueuePauseMark(
  marks: JournalQueuePauseMarks,
  row: JournalTombstoneRow
): void {
  if (isReadableStopEvent(row.stopEvent)) {
    marks.latestStop = { sequence: row.seq, event: row.stopEvent }
  } else if (row.queueResume === true) {
    marks.resumedSequence = row.seq
  } else if (row.queueReopen === true) {
    // Late reopen marks must not narrow earlier boundaries.
    const since = row.queueReopenSince
    const start = typeof since === 'number' && since > 0 && since <= row.seq ? since : row.seq
    marks.reopenedSequence = Math.max(marks.reopenedSequence, start)
  } else if (isReadableQueueClear(row.queueClear)) {
    marks.cleared = { ...row.queueClear, sequence: row.seq }
  }
}

function isReadableQueueClear(
  value: unknown
): value is NonNullable<JournalTombstoneRow['queueClear']> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'operationId' in value &&
    typeof value.operationId === 'string' &&
    value.operationId.length > 0 &&
    'messageIds' in value &&
    Array.isArray(value.messageIds) &&
    value.messageIds.every((id: unknown) => typeof id === 'string' && id.length > 0) &&
    (!('lifted' in value) || value.lifted === true)
  )
}

/** Any later Stop supersedes a personal pause; only personal Stops create one. */
export function journalQueueStopHolds(
  marks: JournalQueuePauseMarks,
  latestAcceptedTurnSequence: number
): boolean {
  return (
    marks.latestStop?.event.reason === 'user-stop' &&
    marks.latestStop.sequence > Math.max(latestAcceptedTurnSequence, marks.resumedSequence)
  )
}

export function journalUserStopInForce(
  marks: JournalQueuePauseMarks,
  latestAcceptedTurnSequence: number
): JournalQueuePauseMarks['latestStop'] {
  return journalQueueStopHolds(marks, latestAcceptedTurnSequence) ? marks.latestStop : null
}

/** Restate clear-lift first, then active Stop/reopen marks so the lift cannot erase them. */
export type JournalQueuePauseRestatement = {
  lifted: boolean
  liveStop: JournalStopEvent | null
  reopened: boolean
  cleared?: { operationId: string; messageIds: string[]; lifted?: true }
}

export function journalQueuePauseRestatement(
  marks: JournalQueuePauseMarks,
  latestAcceptedTurnSequence: number,
  pauses: readonly DerivedQueuePause[]
): JournalQueuePauseRestatement {
  return {
    lifted: latestAcceptedTurnSequence > 0 || marks.resumedSequence > 0,
    liveStop: journalUserStopInForce(marks, latestAcceptedTurnSequence)?.event ?? null,
    reopened: pauses.some((pause) => pause.reason === 'restarted'),
    ...(marks.cleared
      ? {
          cleared: {
            operationId: marks.cleared.operationId,
            messageIds: [...(pauses.find((pause) => pause.reason === 'cleared')?.messageIds ?? [])],
            ...(marks.cleared.lifted ||
            Math.max(latestAcceptedTurnSequence, marks.resumedSequence) >= marks.cleared.sequence
              ? { lifted: true as const }
              : {})
          }
        }
      : {})
  }
}

/** Order determines which reason a card held by multiple pauses displays. */
export function deriveQueuePauses(input: {
  /** Sequences compare only within the same epoch. */
  epoch: string
  marks: JournalQueuePauseMarks
  latestAcceptedTurnSequence: number
  cards: readonly QueueCard[]
  /** Conservative boundary when this handle could not write a reopen mark. */
  reopenFloor: AgentJournalCursor | null
}): DerivedQueuePause[] {
  const { epoch, marks, latestAcceptedTurnSequence } = input
  const pauses: DerivedQueuePause[] = []
  const stop = journalUserStopInForce(marks, latestAcceptedTurnSequence)
  if (stop) {
    pauses.push({ reason: 'stopped', since: { epoch, sequence: stop.sequence } })
  }
  const waiting = input.cards.filter((card) => card.state === 'waiting')
  const cleared = marks.cleared
  if (
    cleared &&
    !cleared.lifted &&
    cleared.sequence > Math.max(latestAcceptedTurnSequence, marks.resumedSequence)
  ) {
    const membership = new Set(cleared.messageIds)
    const messageIds = waiting.flatMap((card) =>
      card.messageId && membership.has(card.messageId) ? [card.messageId] : []
    )
    if (messageIds.length > 0) {
      pauses.push({ reason: 'cleared', since: { epoch, sequence: cleared.sequence }, messageIds })
    }
  }
  const reopened = reopenPause(input)
  if (
    reopened &&
    waiting.some((card) => card.holdReason === null && queuedBefore(reopened, card))
  ) {
    pauses.push(reopened)
  }
  return pauses
}

/** Failed marks use the open boundary conservatively; later turns/Resume lift it, and epochs cannot mix. */
function reopenPause(input: {
  epoch: string
  marks: JournalQueuePauseMarks
  latestAcceptedTurnSequence: number
  reopenFloor: AgentJournalCursor | null
}): DerivedQueuePause | null {
  const { epoch, marks, reopenFloor } = input
  const floor = reopenFloor?.epoch === epoch ? reopenFloor.sequence : 0
  const sequence = Math.max(marks.reopenedSequence, floor)
  if (sequence === 0) {
    return null
  }
  if (Math.max(input.latestAcceptedTurnSequence, marks.resumedSequence) >= sequence) {
    return null
  }
  return { reason: 'restarted', since: { epoch, sequence } }
}

function queuedBefore(pause: DerivedQueuePause, card: QueueCard): boolean {
  if (pause.reason === 'cleared') {
    return pause.messageIds?.includes(card.messageId ?? '') ?? false
  }
  const { since } = pause
  return (
    since === null ||
    card.queuedAt === null ||
    card.queuedAt.epoch !== since.epoch ||
    card.queuedAt.sequence < since.sequence
  )
}

/** Share pause selection across drain, consume and publication; an empty Stop cannot hide a restart. */
export function queuePauseHolding(
  pauses: readonly DerivedQueuePause[],
  card: QueueCard
): DerivedQueuePause | undefined {
  if (card.state !== 'waiting' || card.holdReason !== null) {
    return undefined
  }
  // Post-Stop cards are new instructions but still wait behind held cards.
  return pauses.find((pause) => queuedBefore(pause, card))
}

/** Returned, queue-paused or edited queue cards block later cards. */
export function nextSendableQueuedCard<T extends QueueCard & { messageId: string }>(
  pauses: readonly DerivedQueuePause[],
  cards: readonly T[],
  editHeld: ReadonlySet<string> = new Set()
): T | null {
  for (const card of cards) {
    if (card.state === 'returned' || queuePauseHolding(pauses, card)) {
      return null
    }
    if (card.state === 'waiting' && card.holdReason === null) {
      return editHeld.has(card.messageId) ? null : card
    }
  }
  return null
}

/** Returned queue cards block Resume for their suffix; own-held waiting cards do not. */
export function resumableQueuePause(
  pauses: readonly DerivedQueuePause[],
  cards: readonly QueueCard[]
): DerivedQueuePause | null {
  for (const card of cards) {
    if (card.state === 'returned') {
      return null
    }
    const holding = queuePauseHolding(pauses, card)
    if (holding) {
      return holding
    }
  }
  return null
}

/** A turn sent after `pause` began that the agent has not answered yet: its acceptance lifts the
 *  pause, whoever sent it, so the pause is not shown meanwhile; a refusal shows it again. A send
 *  made before a Stop lifts nothing, so it never counts. */
export function queuePauseLiftOnItsWay<
  Submission extends Pick<AgentJournalSubmission, 'dispatchState' | 'acceptedSequence'>
>(
  pause: DerivedQueuePause,
  submissions: readonly Submission[],
  owesSend: (submission: Submission) => boolean = () => true
): boolean {
  const anchor = pause.since?.sequence ?? 0
  return submissions.some(
    (submission) =>
      submission.dispatchState === 'pending' &&
      (submission.acceptedSequence ?? 0) > anchor &&
      owesSend(submission)
  )
}
