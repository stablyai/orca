import { orchestrationMailNotice } from '../../../../shared/agent-session/agent-session-message-source'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
// Derive pauses from journal state: failed turns, personal Stop, clear and reopen.
// Later accepted turns/Resume lift pauses; per-card holds still require their own action.

import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalStopEvent, JournalTombstoneRow } from '../durable-rows/journal-row-schema'

export type QueuePauseReason = 'stopped' | 'failed' | 'cleared' | 'restarted'

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
  unattended?: boolean
  body?: AgentJournalMessageItem
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
  failureHeld?: boolean
  liveStop: JournalStopEvent | null
  reopened: boolean
  cleared?: { operationId: string; messageIds: string[]; lifted?: true }
}

export function journalQueuePauseRestatement(
  marks: JournalQueuePauseMarks,
  latestAcceptedTurnSequence: number,
  pauses: readonly DerivedQueuePause[],
  latestPersonAcceptedTurnSequence = latestAcceptedTurnSequence
): JournalQueuePauseRestatement {
  return {
    lifted: latestAcceptedTurnSequence > 0 || marks.resumedSequence > 0,
    failureHeld: pauses.some((pause) => pause.reason === 'failed'),
    liveStop: journalUserStopInForce(marks, latestPersonAcceptedTurnSequence)?.event ?? null,
    reopened: pauses.some((pause) => pause.reason === 'restarted'),
    ...(marks.cleared
      ? {
          cleared: {
            operationId: marks.cleared.operationId,
            messageIds: [...(pauses.find((pause) => pause.reason === 'cleared')?.messageIds ?? [])],
            ...(!pauses.some((pause) => pause.reason === 'cleared')
              ? { lifted: true as const }
              : {})
          }
        }
      : {})
  }
}

/** A steer joins the same turn, and a Resume written before the failure cannot waive it. A rebuilt
 * failure sits at the rebuild point, so a Resume at that point was written before it too. */
export function failedQueueTurnSequence(failedAt: number, resumedSequence: number): number {
  return failedAt > 0 && failedAt >= resumedSequence ? failedAt : 0
}

export type QueuePauseFacts = {
  epoch: string
  marks: JournalQueuePauseMarks
  latestAcceptedTurnSequence: number
  latestPersonAcceptedTurnSequence?: number
  failedAt?: number
  reopenFloor: AgentJournalCursor | null
}
export type QueuePauseContext = QueuePauseFacts & {
  pauses: readonly DerivedQueuePause[]
  clearMembers: ReadonlySet<string>
}

/** Boundaries are independent of row revisions; exact clear membership is prepared only when changed. */
export function createQueuePauseContext(
  input: QueuePauseFacts,
  clearMembers: ReadonlySet<string> = new Set(input.marks.cleared?.messageIds)
): QueuePauseContext {
  const { epoch, marks, latestAcceptedTurnSequence } = input
  const pauses: DerivedQueuePause[] = []
  const stop = journalUserStopInForce(
    marks,
    input.latestPersonAcceptedTurnSequence ?? latestAcceptedTurnSequence
  )
  if (stop) {
    pauses.push({ reason: 'stopped', since: { epoch, sequence: stop.sequence } })
  }
  const failed = failedQueueTurnSequence(input.failedAt ?? 0, marks.resumedSequence)
  if (failed) {
    pauses.push({ reason: 'failed', since: { epoch, sequence: failed } })
  }
  const cleared = marks.cleared
  if (cleared && !cleared.lifted) {
    pauses.push({ reason: 'cleared', since: { epoch, sequence: cleared.sequence } })
  }
  const floor = input.reopenFloor?.epoch === epoch ? input.reopenFloor.sequence : 0
  const sequence = Math.max(marks.reopenedSequence, floor)
  if (sequence > 0) {
    pauses.push({ reason: 'restarted', since: { epoch, sequence } })
  }
  return { ...input, pauses, clearMembers }
}

function contextPauseHolds(
  context: QueuePauseContext,
  pause: DerivedQueuePause,
  card: QueueCard
): boolean {
  if (card.state !== 'waiting' || card.holdReason !== null) {
    return false
  }
  if (pause.reason === 'cleared') {
    return (
      context.clearMembers.has(card.messageId ?? '') &&
      heldSince(pause.since!.sequence, card, context)
    )
  }
  return (
    queuedBefore(pause, card) &&
    (pause.reason !== 'restarted' || heldSince(pause.since!.sequence, card, context))
  )
}

export function queuePauseHoldingInContext(
  context: QueuePauseContext,
  card: QueueCard
): DerivedQueuePause | undefined {
  return context.pauses.find((pause) => contextPauseHolds(context, pause, card))
}

/** Full membership is needed only when publishing or restating the pause. */
export function deriveQueuePauses(
  input: QueuePauseFacts & { cards: readonly QueueCard[] }
): DerivedQueuePause[] {
  const context = createQueuePauseContext(input)
  return context.pauses.flatMap((pause) => {
    if (pause.reason === 'stopped' || pause.reason === 'failed') {
      return [pause]
    }
    const messageIds = input.cards.flatMap((card) =>
      card.messageId && contextPauseHolds(context, pause, card) ? [card.messageId] : []
    )
    return messageIds.length > 0 ? [{ ...pause, messageIds }] : []
  })
}

function heldSince(
  sequence: number,
  card: QueueCard,
  input: {
    marks: JournalQueuePauseMarks
    latestAcceptedTurnSequence: number
    latestPersonAcceptedTurnSequence?: number
  }
): boolean {
  const accepted =
    card.unattended === false
      ? (input.latestPersonAcceptedTurnSequence ?? input.latestAcceptedTurnSequence)
      : input.latestAcceptedTurnSequence
  return sequence > Math.max(accepted, input.marks.resumedSequence)
}

const pauseMembership = new WeakMap<DerivedQueuePause, ReadonlySet<string>>()

function queuedBefore(pause: DerivedQueuePause, card: QueueCard): boolean {
  if (pause.reason === 'stopped' && orchestrationMailNotice(card.body?.from)) {
    return false
  }
  if (pause.messageIds) {
    let members = pauseMembership.get(pause)
    if (!members) {
      members = new Set(pause.messageIds)
      pauseMembership.set(pause, members)
    }
    if (!members.has(card.messageId ?? '')) {
      return false
    }
  }
  if (pause.reason === 'failed') {
    return true
  }
  if (pause.reason === 'cleared') {
    return pause.messageIds !== undefined
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
  return pauses.find((pause) => queuedBefore(pause, card))
}

/** Automatic claims skip held rows; a live edit lease is a barrier. */
export function nextSendableQueuedCard<T extends QueueCard & { messageId: string }>(
  pauses: readonly DerivedQueuePause[],
  cards: readonly T[],
  editHeld: ReadonlySet<string> = new Set()
): T | null {
  for (const card of cards) {
    if (editHeld.has(card.messageId)) {
      return null
    }
    if (card.state === 'waiting' && card.holdReason === null && !queuePauseHolding(pauses, card)) {
      return card
    }
  }
  return null
}

/** Resume applies when any waiting row is held by a queue pause. */
export function resumableQueuePause(
  pauses: readonly DerivedQueuePause[],
  cards: readonly QueueCard[]
): DerivedQueuePause | null {
  for (const card of cards) {
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
