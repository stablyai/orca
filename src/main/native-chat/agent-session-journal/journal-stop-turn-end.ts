// What a Stop decides about the turn it stopped: the one rule every turn-end write passes through.
//
// A turn a person's Stop or close of this chat named, or, when it named none, one that ended while
// that Stop settled or that its settle bound, ending with no verdict of its own after that Stop's
// event, ends as their cancellation. A host stop, an eviction and no Stop at all leave the end as
// written. It runs where each row is built, inside the journal's serialized write: the adapter's
// end, the host's fallback and a relaunch's settle all write through it, and every client folds
// the row it wrote. What an unnamed Stop binds is held in memory, so after a relaunch it binds none.

import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { JournalReducerState } from './journal-reducer'
import type { JournalStopEvent } from './journal-row-schema'
import type { JournalQueuePauseMarks, JournalStopSettle } from './queued-message-pause'

export type JournalLatestStop = NonNullable<JournalQueuePauseMarks['latestStop']>

/** Only a person's own Stop, or their close of this chat, makes a cut turn their cancellation. */
export function stopIsAPersons(reason: JournalStopEvent['reason']): boolean {
  switch (reason) {
    case 'user-stop':
    case 'user-close':
      return true
    case 'host-stop':
    case 'evict':
      return false
  }
}

type TurnEndState = Pick<
  JournalReducerState,
  'items' | 'queuePauseMarks' | 'submissions' | 'aliases'
>

/** The send whose journal item `userItemId` (a turn's opener, by its own or its provider key) is.
 *  Only says whether a send's turn has opened; it never decides whose a turn's end is. */
function openingSubmission(
  state: TurnEndState,
  userItemId: string | undefined
): AgentJournalSubmission | undefined {
  if (userItemId === undefined) {
    return undefined
  }
  const identity = parseAgentJournalItemKey(state.aliases.get(userItemId) ?? userItemId)
  return identity?.provider === 'orca' && 'clientMessageId' in identity
    ? state.submissions.get(identity.clientMessageId)
    : undefined
}

/** Whether the latest send the agent accepted to open a turn has opened none the journal holds: its
 *  turn's row may still be on its way. A send delivered into a running turn (a steer, a fold)
 *  opens none, and its item carries that turn's scope (`placeHandedOverMessage`). */
export function latestAcceptedSendUnopened(state: TurnEndState): boolean {
  let latest: { submission: AgentJournalSubmission; sequence: number } | undefined
  for (const submission of state.submissions.values()) {
    const item = state.items.get(agentJournalSubmissionKey(submission.clientMessageId))
    if (
      submission.dispatchState === 'accepted' &&
      item !== undefined &&
      item.turnScope?.kind !== 'turn' &&
      item.sequence >= (latest?.sequence ?? -1)
    ) {
      latest = { submission, sequence: item.sequence }
    }
  }
  if (!latest) {
    return false
  }
  for (const item of state.items.values()) {
    if (
      openingSubmission(state, readAgentJournalTurn(item.body)?.userItemId) === latest.submission
    ) {
      return false
    }
  }
  return true
}

/** Whether `stop`, a person's, makes the end of turn `turnId` theirs: it named that turn, or named
 *  none and the turn ends while it settles, or its settle bound that turn. */
function stopIsTurnCancellation(stop: JournalLatestStop, turnId: string): boolean {
  if (!stopIsAPersons(stop.event.reason)) {
    return false
  }
  if (stop.event.turnId !== undefined) {
    return stop.event.turnId === turnId
  }
  return stop.settle?.settling === true || stop.settle?.turnId === turnId
}

/** THE rule: whether the latest Stop makes turn `turnId`, ending at `endedAt` with no verdict of its
 *  own, a person's cancellation. An exit the provider saw before the Stop was news, whenever its
 *  end is written. */
function stopEndsTurnAsCancellation(
  state: TurnEndState,
  turnId: string,
  endedAt: number | undefined
): boolean {
  const stop = state.queuePauseMarks.latestStop
  return (
    stop !== null &&
    stopIsTurnCancellation(stop, turnId) &&
    (endedAt === undefined || endedAt >= stop.event.at)
  )
}

/**
 * Whether a person's Stop decides the end of turn `turnId` (null: the work in flight with no turn
 * running), by `turnEndAfterStop`'s rule: ending at `endedAt` it is their cancellation, and still
 * running it is theirs to end. For a writer that must choose before the end is written: a host
 * stop must not supersede it, and a Claude error result naming no reason leaves its verdict to it.
 */
export function personStopDecidesTurn(
  state: TurnEndState,
  turnId: string | null,
  endedAt?: number
): boolean {
  const stop = state.queuePauseMarks.latestStop
  if (stop === null || !stopIsAPersons(stop.event.reason)) {
    return false
  }
  if (turnId === null) {
    return stop.event.turnId === undefined && stop.settle?.settling === true
  }
  return stopEndsTurnAsCancellation(state, turnId, endedAt)
}

/** Opens the settle of the latest Stop, a person's that named no turn: until it closes, every turn
 *  that ends is that Stop's. Null when there is none, or it named its turn. */
export function beginJournalStopSettle(
  state: Pick<JournalReducerState, 'queuePauseMarks'>
): JournalStopSettle | null {
  const stop = state.queuePauseMarks.latestStop
  if (stop === null || stop.event.turnId !== undefined || !stopIsAPersons(stop.event.reason)) {
    return null
  }
  // A repeat press keeps the turn an earlier one bound.
  stop.settle = { settling: true, ...(stop.settle?.turnId ? { turnId: stop.settle.turnId } : {}) }
  return stop.settle
}

/**
 * The body to write for item `itemId`: unchanged unless it ends, with no verdict of its own and no
 * earlier than the latest Stop event, a person's that named it or bound it, while it was still open
 * (running, or unproven). A provider's own verdict always stands.
 */
export function turnEndAfterStop(
  state: TurnEndState,
  itemId: string,
  body: AgentJournalItemBody
): AgentJournalItemBody {
  if (body.kind !== 'turn' || body.state !== 'interrupted' || body.outcome !== undefined) {
    return body
  }
  const previous = readAgentJournalTurn(state.items.get(itemId)?.body)
  // An end already written stands: the Stop came after it.
  if (previous && previous.state !== 'running' && previous.state !== 'unverifiable') {
    return body
  }
  return stopEndsTurnAsCancellation(state, body.turnId, body.completedAt)
    ? { ...body, outcome: 'cancellation' }
    : body
}
