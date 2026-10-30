// All turn-end writers apply this rule on the journal lane. Session-ending Stop bindings are memory-only
// and disappear on relaunch; provider verdicts and ends observed before Stop retain their meaning.

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

export function stopIsAPersons(reason: JournalStopEvent['reason']): boolean {
  switch (reason) {
    case 'user-stop':
    case 'user-close':
      return true
    case 'context-clear':
    case 'host-stop':
    case 'evict':
      return false
  }
}

type TurnEndState = Pick<
  JournalReducerState,
  'items' | 'queuePauseMarks' | 'submissions' | 'aliases'
>

/** Find the opening send; this does not decide cancellation ownership. */
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

/** Accepted openers may precede their turn row; steers/folds into running turns open none. */
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

/** A session-ending Stop owns every turn ending while it settles; a targeted Stop owns its turn. */
function stopIsTurnCancellation(stop: JournalLatestStop, turnId: string): boolean {
  if (!stopIsAPersons(stop.event.reason)) {
    return false
  }
  return stop.settle?.settling || stop.settle?.turnId === turnId || stop.event.turnId === turnId
}

/** Ends observed before Stop keep their meaning even if written later. */
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

/** Let writers defer to personal Stop before ending a turn; null denotes work without a turn. */
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
    return stop.settle?.settling === true
  }
  return stopEndsTurnAsCancellation(state, turnId, endedAt)
}

/** Until its child closes, a session-ending Stop owns all turns; other callers stay unnamed-only. */
export function beginJournalStopSettle(
  state: Pick<JournalReducerState, 'queuePauseMarks'>,
  endsSession = false
): JournalStopSettle | null {
  const stop = state.queuePauseMarks.latestStop
  const targeted = !endsSession && stop?.event.turnId !== undefined
  if (stop === null || targeted || !stopIsAPersons(stop.event.reason)) {
    return null
  }
  // Repeated Stop preserves the earlier bound turn.
  stop.settle = { settling: true, ...(stop.settle?.turnId ? { turnId: stop.settle.turnId } : {}) }
  return stop.settle
}

/** Preserve provider verdicts and already-ended turns; otherwise apply the latest matching personal Stop. */
export function turnEndAfterStop(
  state: TurnEndState,
  itemId: string,
  body: AgentJournalItemBody
): AgentJournalItemBody {
  if (body.kind !== 'turn' || body.state !== 'interrupted' || body.outcome !== undefined) {
    return body
  }
  const previous = readAgentJournalTurn(state.items.get(itemId)?.body)
  // An already-written end predates this Stop.
  if (previous && previous.state !== 'running' && previous.state !== 'unverifiable') {
    return body
  }
  return stopEndsTurnAsCancellation(state, body.turnId, body.completedAt)
    ? { ...body, outcome: 'cancellation' }
    : body
}
