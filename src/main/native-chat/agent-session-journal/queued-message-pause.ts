// The queue's pauses: a pure function of the journal fold and the cards, never a stored flag, so
// nothing has to retire them. Each holds its own cards (`queuePauseHolding`). In force when:
//   - 'stopped': the latest Stop event is a person's (reason `user-stop`), with no later Resume row
//     and no turn a person asked for sent after it and accepted. A later Stop of any reason
//     supersedes it; only a person's pauses.
//   - 'cleared': a card /clear carried into this conversation waits, and no person's turn or
//     Resume has happened here since.
//   - 'restarted': a waiting card with no hold of its own was written by another host process, and
//     no person's turn has started since this conversation opened.
// A card held on its own (`hold_reason`) is outside every pause: only an action on it releases it.
// A person's turn is an accepted submission of origin `client`. Orchestration mail, a restart
// continuation, a launch prompt and the queue's own drain are `host` and never lift it.

import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
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

/** The latest Stop event, whatever its reason, and the latest Resume row, folded by the reducer. */
export type JournalQueuePauseMarks = {
  latestStop: { sequence: number; event: JournalStopEvent; settle?: JournalStopSettle } | null
  /** 0 when none. */
  resumedSequence: number
}

export type DerivedQueuePause = {
  reason: QueuePauseReason
  /** Where a Stop's pause began: a card queued at or after it is newer. Null for the others. */
  since: AgentJournalCursor | null
}

type QueueCard = {
  state: string
  holdReason: string | null
  hostInstance: string
  carriedFrom: string | null
  queuedAt: AgentJournalCursor | null
}

export function createJournalQueuePauseMarks(): JournalQueuePauseMarks {
  return { latestStop: null, resumedSequence: 0 }
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
  }
}

/** A person's Stop still pauses: it is the latest Stop, and nothing a person did since, and no
 *  Resume, ended it. A later Stop for any other reason ends it without pausing itself. */
export function journalQueueStopHolds(
  marks: JournalQueuePauseMarks,
  latestPersonTurnSequence: number
): boolean {
  return (
    marks.latestStop?.event.reason === 'user-stop' &&
    marks.latestStop.sequence > Math.max(latestPersonTurnSequence, marks.resumedSequence)
  )
}

/** The latest person's Stop while it still pauses, with where it was written; else null. */
export function journalUserStopInForce(
  marks: JournalQueuePauseMarks,
  latestPersonTurnSequence: number
): JournalQueuePauseMarks['latestStop'] {
  return journalQueueStopHolds(marks, latestPersonTurnSequence) ? marks.latestStop : null
}

/** What a rewind's new epoch restates so its pauses read as they did: a lift of /clear's pause (a
 *  person's turn or a Resume happened), then the Stop still in force, in that order so the lift
 *  never ends the Stop. */
export type JournalQueuePauseRestatement = {
  lifted: boolean
  liveStop: JournalStopEvent | null
}

export function journalQueuePauseRestatement(
  marks: JournalQueuePauseMarks,
  latestPersonTurnSequence: number
): JournalQueuePauseRestatement {
  return {
    lifted: latestPersonTurnSequence > 0 || marks.resumedSequence > 0,
    liveStop: journalUserStopInForce(marks, latestPersonTurnSequence)?.event ?? null
  }
}

/** Every pause in force, in the order a card held by several names its reason. */
export function deriveQueuePauses(input: {
  /** The journal's epoch: sequences compare only within one. */
  epoch: string
  marks: JournalQueuePauseMarks
  latestPersonTurnSequence: number
  cards: readonly QueueCard[]
  hostInstance: string
  /** A person's turn started since this conversation opened. */
  restartEnded: boolean
}): DerivedQueuePause[] {
  const { epoch, marks, latestPersonTurnSequence } = input
  const pauses: DerivedQueuePause[] = []
  const stop = journalUserStopInForce(marks, latestPersonTurnSequence)
  if (stop) {
    pauses.push({ reason: 'stopped', since: { epoch, sequence: stop.sequence } })
  }
  const waiting = input.cards.filter((card) => card.state === 'waiting')
  const carried = waiting.filter((card) => card.carriedFrom !== null)
  if (carried.length > 0 && latestPersonTurnSequence === 0 && marks.resumedSequence === 0) {
    pauses.push({ reason: 'cleared', since: null })
  }
  // A card held on its own waits for its own Send whoever wrote it, so it pauses nothing else.
  const foreign = waiting.some(
    (card) => card.holdReason === null && card.hostInstance !== input.hostInstance
  )
  if (!input.restartEnded && foreign) {
    // The process that wrote a card is gone: every card waits, whenever it was written.
    pauses.push({ reason: 'restarted', since: null })
  }
  return pauses
}

/** Queued before the pause began: for /clear, a card it carried; for a restart, every card. For a
 *  Stop, a card queued before its row; one from another epoch (before a rewind) or from a build
 *  that recorded no position counts as before. A withdrawn steer keeps its position, so is held. */
function queuedBeforePause(pause: DerivedQueuePause, card: QueueCard): boolean {
  if (pause.reason === 'cleared') {
    return card.carriedFrom !== null
  }
  const { since } = pause
  return (
    since === null ||
    card.queuedAt === null ||
    card.queuedAt.epoch !== since.epoch ||
    card.queuedAt.sequence < since.sequence
  )
}

// Product decision: a card queued AFTER a Stop is a new instruction and is not held; only cards
// queued before it, and a steer it withdrew, wait. It still never jumps ahead of one a pause holds:
// the drain stops at the first one. true instead holds every waiting card, whenever it was queued.
const PAUSE_HOLDS_CARDS_QUEUED_AFTER_IT = false

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
  return pauses.find((pause) => PAUSE_HOLDS_CARDS_QUEUED_AFTER_IT || queuedBeforePause(pause, card))
}

/** The card the queue sends next: the oldest waiting one with no hold of its own, unless a
 *  returned card or one a pause holds comes first. The queue never reorders, so a newer card never
 *  overtakes one a pause holds; a card held on its own is passed over. The drain's pick and its
 *  consume both read this. */
export function nextSendableQueuedCard<T extends QueueCard>(
  pauses: readonly DerivedQueuePause[],
  cards: readonly T[]
): T | null {
  for (const card of cards) {
    if (card.state === 'returned' || queuePauseHolding(pauses, card)) {
      return null
    }
    if (card.state === 'waiting' && card.holdReason === null) {
      return card
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
