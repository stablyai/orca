// What a Stop decides about the turn it named: the one rule every turn-end write passes through.
//
// A turn a person's Stop or close of this chat named, or, when it named none, a turn opened by a
// send it stopped, ending with no verdict of its own after that Stop's event, ends as their
// cancellation. A host stop, an eviction and no Stop at all leave the end as written. It runs
// where each row is built, inside the journal's serialized write, so it reads every Stop folded
// before the end: the adapter's settle, the host's fallback and a relaunch's settle all write
// through it, and every client folds the row it wrote.

import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { isUnansweredStructuredAgentSessionDispatch } from '../../../shared/structured-agent-session-unanswered-dispatch'
import type { JournalReducerState } from './journal-reducer'
import type { JournalStopEvent } from './journal-row-schema'
import type { JournalQueuePauseMarks } from './queued-message-pause'

export type JournalLatestStop = NonNullable<JournalQueuePauseMarks['latestStop']>

/** Only a person's own Stop, or their close of this chat, makes a cut turn their cancellation. */
function stopIsAPersons(reason: JournalStopEvent['reason']): boolean {
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

/** The send whose journal item `userItemId` (a turn's opener, by its own or its provider key) is. */
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

/** The latest send the agent accepted to open a turn, while the journal holds no turn it opened:
 *  that turn's row may still be on its way. A send delivered into a running turn (a steer, a fold)
 *  opens none, and its item carries that turn's scope (`placeHandedOverMessage`). */
function latestAcceptedSendUnopened(state: TurnEndState): AgentJournalSubmission | undefined {
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
    return undefined
  }
  for (const item of state.items.values()) {
    if (
      openingSubmission(state, readAgentJournalTurn(item.body)?.userItemId) === latest.submission
    ) {
      return undefined
    }
  }
  return latest.submission
}

/** A send a Stop that named no turn stopped: one already handed to the agent at the Stop's
 *  position, whose turn had not opened. A card the Stop held, or anything sent after it, is not. */
function isStopTarget(
  state: TurnEndState,
  stop: JournalLatestStop,
  submission: AgentJournalSubmission
): boolean {
  if (
    submission.dispatchState === 'rejected' ||
    (submission.handoverRecorded === true && submission.handedOverAt === undefined)
  ) {
    return false
  }
  // A handed-over send's item sits at its handover (`placeHandedOverMessage`).
  const handedOver = state.items.get(agentJournalSubmissionKey(submission.clientMessageId))
  return handedOver !== undefined && handedOver.sequence < stop.sequence
}

/** Whether `stop`, a person's, makes the end of turn `turnId` theirs: it named that turn, or named
 *  none and stopped the send that opened it (`userItemId`). */
function stopIsTurnCancellation(
  state: TurnEndState,
  stop: JournalLatestStop,
  turnId: string,
  userItemId: string | undefined
): boolean {
  if (!stopIsAPersons(stop.event.reason)) {
    return false
  }
  if (stop.event.turnId !== undefined) {
    return stop.event.turnId === turnId
  }
  const opener = openingSubmission(state, userItemId)
  return opener !== undefined && isStopTarget(state, stop, opener)
}

/** THE rule: whether the latest Stop makes turn `turnId`, opened by `userItemId` and ending at
 *  `endedAt` with no verdict of its own, a person's cancellation. An exit the provider saw before
 *  the Stop was news, whenever its end is written. */
function stopEndsTurnAsCancellation(
  state: TurnEndState,
  turnId: string,
  userItemId: string | undefined,
  endedAt: number | undefined
): boolean {
  const stop = state.queuePauseMarks.latestStop
  return (
    stop !== null &&
    stopIsTurnCancellation(state, stop, turnId, userItemId) &&
    (endedAt === undefined || endedAt >= stop.event.at)
  )
}

/** With no turn row running, the work in flight is the person's Stop's: every send still
 *  unanswered, and one accepted whose turn's row has yet to land, is one it stopped. */
function sendsInFlightAreStopTargets(state: TurnEndState, stop: JournalLatestStop): boolean {
  const inFlight = [...state.submissions.values()].filter((submission) =>
    isUnansweredStructuredAgentSessionDispatch(submission)
  )
  const unopened = latestAcceptedSendUnopened(state)
  if (unopened) {
    inFlight.push(unopened)
  }
  return (
    inFlight.length > 0 && inFlight.every((submission) => isStopTarget(state, stop, submission))
  )
}

/**
 * Whether a person's Stop decides the end of turn `turnId` (null: the sends in flight with no turn
 * running), by `turnEndAfterStop`'s rule: ending at `endedAt` it is their cancellation, and still
 * running it is theirs to end. For a writer that must choose before the end is written: a host
 * stop must not supersede it, and a Claude error result naming no reason leaves its verdict to it.
 */
export function personStopDecidesTurn(
  state: TurnEndState,
  turnId: string | null,
  endedAt?: number,
  /** The submission that opened the turn, for one whose rows have yet to land. */
  openedBy?: string
): boolean {
  const stop = state.queuePauseMarks.latestStop
  if (stop === null || !stopIsAPersons(stop.event.reason)) {
    return false
  }
  if (turnId === null) {
    return stop.event.turnId === undefined && sendsInFlightAreStopTargets(state, stop)
  }
  const turn = [...state.items.values()]
    .map((item) => readAgentJournalTurn(item.body))
    .find((candidate) => candidate?.turnId === turnId)
  const userItemId =
    turn?.userItemId ?? (openedBy === undefined ? undefined : agentJournalSubmissionKey(openedBy))
  return stopEndsTurnAsCancellation(state, turnId, userItemId, endedAt)
}

/**
 * The body to write for item `itemId`: unchanged unless it ends, with no verdict of its own and no
 * earlier than the latest Stop event, a person's, which named it, or stopped the send that opened
 * it, while it was still open (running, or unproven). A provider's own verdict always stands.
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
  const userItemId = body.userItemId ?? previous?.userItemId
  return stopEndsTurnAsCancellation(state, body.turnId, userItemId, body.completedAt)
    ? { ...body, outcome: 'cancellation' }
    : body
}
