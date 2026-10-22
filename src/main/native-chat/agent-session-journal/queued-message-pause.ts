// The queue's pauses: a pure function of the journal fold and the cards, never a stored flag, so
// nothing has to retire them. Each holds its own cards (`queuePauseHolding`). In force when:
//   - 'stopped': the latest Stop event is a person's (reason `user-stop`), with no later Resume row
//     and no turn sent after it and accepted. A later Stop of any reason supersedes it; only a
//     person's pauses.
//   - 'cleared': a card named by the latest clear mark waits, with no later accepted turn or Resume.
//   - 'restarted': a card queued before this conversation last opened waits — Orca quit or
//     crashed, or the chat closed, while it waited — and no turn or Resume has happened since the
//     open. The open marks itself with a row when it finds waiting cards (`queueReopen`), so a card
//     queued after it is never mistaken for one from before. Never published: nothing sends by
//     itself, and the next turn (the carry-on or the person's own message) runs first.
// Any accepted turn lifts them, whoever sent it: a person, Orca's own messages, or the queue.
// A card held on its own (`hold_reason`, a failed conversion) is outside every pause: only an
// action on it releases it.

import type {
  AgentJournalCursor,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import type { JournalStopEvent, JournalTombstoneRow } from './journal-row-schema'

export type QueuePauseReason = 'stopped' | 'cleared' | 'restarted'

/** What a person's Stop that named no turn binds, held in memory and never read from a row, so a
 *  reopen binds nothing: while it settles, every turn that ends; once settled, the turn it stopped.
 *  `failedOn`: the turn a Stop that failed could not stop, which reads "Stopping…" until it ends:
 *  the one running when it failed, or with none, the first that opens after the journal position
 *  it failed at. Display only: no turn-end rule reads it, so that turn's own end stays its own. */
export type JournalStopSettle = {
  settling: boolean
  turnId?: string
  failedOn?: JournalStopFailedOn
}

export type JournalStopFailedOn = { turnId: string } | { openedAfter: number }

/** The latest Stop event, whatever its reason, the latest Resume row and the latest reopen mark,
 *  folded by the reducer. */
export type JournalQueuePauseMarks = {
  cleared?: { sequence: number; operationId: string; messageIds: readonly string[]; lifted?: true }
  latestStop: { sequence: number; event: JournalStopEvent; settle?: JournalStopSettle } | null
  /** 0 when none. */
  resumedSequence: number
  /** 0 when none. */
  reopenedSequence: number
}

export type DerivedQueuePause = {
  reason: QueuePauseReason
  /** Where the pause began; clear holds its exact recorded message IDs. */
  since: AgentJournalCursor | null
  messageIds?: readonly string[]
}

type QueueCard = {
  messageId?: string
  state: string
  holdReason: string | null
  queuedAt: AgentJournalCursor | null
}

export function createJournalQueuePauseMarks(): JournalQueuePauseMarks {
  return { latestStop: null, resumedSequence: 0, reopenedSequence: 0 }
}

/** The keys are read from disk unchecked: a value no build writes (a corrupt row) is ignored. */
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
    // Never earlier than a mark before it: a late mark of one send narrows no wider one.
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

/** A person's Stop still pauses: it is the latest Stop, and no turn accepted since, and no
 *  Resume, ended it. A later Stop for any other reason ends it without pausing itself. */
export function journalQueueStopHolds(
  marks: JournalQueuePauseMarks,
  latestAcceptedTurnSequence: number
): boolean {
  return (
    marks.latestStop?.event.reason === 'user-stop' &&
    marks.latestStop.sequence > Math.max(latestAcceptedTurnSequence, marks.resumedSequence)
  )
}

/** The latest person's Stop while it still pauses, with where it was written; else null. */
export function journalUserStopInForce(
  marks: JournalQueuePauseMarks,
  latestAcceptedTurnSequence: number
): JournalQueuePauseMarks['latestStop'] {
  return journalQueueStopHolds(marks, latestAcceptedTurnSequence) ? marks.latestStop : null
}

/** What a rewind's new epoch restates so its pauses read as they did: a lift of /clear's pause (a
 *  turn or a Resume happened), then the Stop still in force, then the reopen's pause still holding
 *  a card, in that order so the lift never ends either. */
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

/** Every pause in force, in the order a card held by several names its reason. */
export function deriveQueuePauses(input: {
  /** The journal's epoch: sequences compare only within one. */
  epoch: string
  marks: JournalQueuePauseMarks
  latestAcceptedTurnSequence: number
  cards: readonly QueueCard[]
  /** Where the reopen's pause begins when this handle could not mark it; null otherwise. */
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

/** Where the latest reopen began: its mark, or, when this handle could not write one, the open
 *  itself, so a failed write holds a little more and never sends anything by itself. A floor from
 *  another epoch is not this one's (a rewind restates the mark). Null once a turn or a Resume came
 *  after it. */
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

/** Clear holds recorded IDs; other pauses compare queued positions within the journal epoch. */
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

/** THE rule for which cards are held: by ANY pause in force, named by the first that holds it, so
 *  a Stop's that holds nothing never hides a restart's. The drain, its consume, and publication
 *  all read it. */
export function queuePauseHolding(
  pauses: readonly DerivedQueuePause[],
  card: QueueCard
): DerivedQueuePause | undefined {
  if (card.state !== 'waiting' || card.holdReason !== null) {
    return undefined
  }
  // A card queued AFTER a Stop is a new instruction and is not held; it still waits behind a held one.
  return pauses.find((pause) => queuedBefore(pause, card))
}

/** The card the queue sends next: the oldest waiting one with no hold of its own, unless a
 *  returned card, one a pause holds, or one being edited (`editHeld`) comes first. The queue never
 *  reorders, so a newer card never overtakes either; a card held on its own is passed over. The
 *  drain's pick and its consume both read this. */
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

/** The pause to PUBLISH: the one holding the first card Resume would send, not behind a returned
 *  card, which blocks everything after it until the user acts. None otherwise, so its header
 *  never offers a Resume that sends nothing. */
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
export function queuePauseLiftOnItsWay(
  pause: DerivedQueuePause,
  submissions: readonly Pick<AgentJournalSubmission, 'dispatchState' | 'acceptedSequence'>[]
): boolean {
  const anchor = pause.since?.sequence ?? 0
  return submissions.some(
    (submission) =>
      submission.dispatchState === 'pending' && (submission.acceptedSequence ?? 0) > anchor
  )
}
