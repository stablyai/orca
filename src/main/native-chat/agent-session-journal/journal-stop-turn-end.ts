import { journalItemExecutionFence } from './journal-item-provenance'
import { activeCancellations, executionCancellation } from './journal-stop-cancellation'
import { turnOpeningClientId } from './journal-cancellation-targets'
// All turn-end writers apply this rule on the journal lane. Session-ending Stop bindings are memory-only
// and disappear on relaunch; provider verdicts and ends observed before Stop retain their meaning.

import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
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
  | 'items'
  | 'queuePauseMarks'
  | 'submissions'
  | 'aliases'
  | 'itemFences'
  | 'itemExecutionOwners'
  | 'derivedTurnScope'
>

/** Accepted openers may precede their turn row; steers/folds into running turns open none. */
export function latestAcceptedSendUnopened(state: TurnEndState): boolean {
  return state.derivedTurnScope.cancellations
    .unresolved()
    .some(
      (target) =>
        target.turnId === undefined &&
        target.clientMessageId !== undefined &&
        state.submissions.get(target.clientMessageId)?.dispatchState === 'accepted'
    )
}

/** Every consumer resolves the same captured execution, independently of the queue boundary. */
function stopEndsTurnAsCancellation(
  state: TurnEndState,
  turnId: string,
  endedAt?: number,
  userItemId?: string,
  ownerFence?: number
): boolean {
  const opener = turnOpeningClientId(state, userItemId)
  return activeCancellations(state).some(
    (stop) =>
      (ownerFence === undefined || stop.target?.ownerFence === ownerFence) &&
      (stop.target?.turnId === turnId ||
        (opener !== undefined && stop.target?.clientMessageId === opener)) &&
      (endedAt === undefined || endedAt >= stop.event.at)
  )
}

/** Let writers defer to personal Stop before ending a turn; null denotes work without a turn. */
export function personStopDecidesTurn(
  state: TurnEndState,
  turnId: string | null,
  endedAt?: number
): boolean {
  if (turnId === null) {
    return executionCancellation(state, null) !== undefined
  }
  return stopEndsTurnAsCancellation(state, turnId, endedAt)
}

/** Until its child closes, a session-ending Stop owns all turns; other callers stay unnamed-only. */
export function beginJournalStopSettle(
  state: Pick<JournalReducerState, 'queuePauseMarks' | 'derivedTurnScope'>,
  endsSession = false,
  sequence?: number
): JournalStopSettle | null {
  const pending = activeCancellations(state)
  const stop =
    sequence === undefined
      ? (pending.at(-1) ?? state.queuePauseMarks.latestStop)
      : (pending.find((entry) => entry.sequence === sequence) ??
        (state.queuePauseMarks.latestStop?.sequence === sequence
          ? state.queuePauseMarks.latestStop
          : null))
  if (!stop || !stopIsAPersons(stop.event.reason)) {
    return null
  }
  if (sequence === undefined && !endsSession && stop.event.turnId !== undefined) {
    return null
  }
  stop.settle = { settling: true, ...(stop.settle?.turnId ? { turnId: stop.settle.turnId } : {}) }
  return stop.settle
}

/** Preserve provider verdicts and already-ended turns; otherwise apply the latest matching personal Stop. */
export function turnEndAfterStop(
  state: TurnEndState,
  itemId: string,
  body: AgentJournalItemBody,
  ownerFence = journalItemExecutionFence(state, itemId)
): AgentJournalItemBody {
  if (body.kind !== 'turn' || body.state !== 'interrupted' || body.outcome !== undefined) {
    return body
  }
  const previous = readAgentJournalTurn(state.items.get(itemId)?.body)
  // An already-written end predates this Stop.
  if (previous && previous.state !== 'running' && previous.state !== 'unverifiable') {
    return body
  }
  return stopEndsTurnAsCancellation(
    state,
    body.turnId,
    body.completedAt,
    body.userItemId,
    ownerFence
  )
    ? { ...body, outcome: 'cancellation' }
    : body
}
