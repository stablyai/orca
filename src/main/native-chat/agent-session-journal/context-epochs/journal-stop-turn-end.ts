import { memoryJournalMap } from '../journal-memory-collections'
import { getJournalInputOrder } from '../input-order/journal-input-order-registry'
// All turn-end writers apply this rule on the journal lane. Session-ending Stop bindings are memory-only
// and disappear on relaunch; success verdicts, ends observed before Stop, and failures long after it
// retain their meaning.

import type {
  AgentJournalItemBody,
  AgentJournalSubmission
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type { JournalReducerState } from '../projection/journal-reducer'
import type { JournalStopEvent } from '../durable-rows/journal-row-schema'
import type {
  JournalQueuePauseMarks,
  JournalStopSettle
} from '../queued-messages/queued-message-pause-marks'

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

/** Accepted openers may precede their turn row; steers/folds into running turns open none. */
export function latestAcceptedSendUnopened(state: JournalReducerState): boolean {
  return state.queries.latestAcceptedUnopened(state)
}

export function memoryLatestAcceptedSendUnopened(state: JournalReducerState): boolean {
  let latest: { submission: AgentJournalSubmission; sequence: number } | undefined
  const owner = getJournalInputOrder(state)!
  for (const item of memoryJournalMap(state.items).values()) {
    const submission = owner.inputForItem(item.itemId)
    if (
      submission?.dispatchState === 'accepted' &&
      item.turnScope?.kind !== 'turn' &&
      (!latest ||
        item.sequence > latest.sequence ||
        (item.sequence === latest.sequence &&
          owner.inputOrdinal(submission.clientMessageId) >
            owner.inputOrdinal(latest.submission.clientMessageId)))
    ) {
      latest = { submission, sequence: item.sequence }
    }
  }
  if (!latest) {
    return false
  }
  for (const item of memoryJournalMap(state.items).values()) {
    const opener = readAgentJournalTurn(item.body)?.userItemId
    if (opener && owner.inputForItem(state.aliases.get(opener) ?? opener) === latest.submission) {
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

/** How soon after a person's Stop a provider's failure for that turn is the Stop's: an interrupt's
 *  round trip and Codex's stop grace fit well inside it; a crash later than this is its own. */
export const STOP_DECIDES_FAILURE_MS = 30_000

/** A turn end the Stop rule may decide: an end with no verdict, or a provider failure (an
 *  interrupt that aborts a request can surface as one, as Claude's error results do). */
export function turnEndStopMayDecide(body: AgentJournalItemBody): boolean {
  return (
    body.kind === 'turn' &&
    ((body.state === 'interrupted' && body.outcome === undefined) || body.outcome === 'failure')
  )
}

/** A failure the person's Stop owning this turn caused: it ended at or after that Stop and within
 *  the window after it. The one rule for a turn's failed end and for its error rows. */
export function personStopDecidesFailure(
  state: TurnEndState,
  turnId: string,
  endedAt: number | undefined
): boolean {
  const stop = state.queuePauseMarks.latestStop
  return (
    stop !== null &&
    endedAt !== undefined &&
    endedAt - stop.event.at <= STOP_DECIDES_FAILURE_MS &&
    stopEndsTurnAsCancellation(state, turnId, endedAt)
  )
}

/** Preserve success verdicts and already-ended turns; otherwise apply the latest matching personal
 *  Stop. A failure reads as the Stop's only when it ended soon after that Stop. */
export function turnEndAfterStop(
  state: TurnEndState,
  itemId: string,
  body: AgentJournalItemBody
): AgentJournalItemBody {
  if (body.kind !== 'turn' || !turnEndStopMayDecide(body)) {
    return body
  }
  const previous = readAgentJournalTurn(state.items.get(itemId)?.body)
  if (previous && previous.state !== 'running' && previous.state !== 'unverifiable') {
    // A later revision of the end the Stop already decided keeps that verdict.
    if (previous.outcome === 'cancellation' && previous.completedAt === body.completedAt) {
      return { ...body, state: previous.state, outcome: 'cancellation' }
    }
    // An already-written end predates this Stop.
    return body
  }
  const stopped =
    body.outcome === 'failure'
      ? personStopDecidesFailure(state, body.turnId, body.completedAt)
      : stopEndsTurnAsCancellation(state, body.turnId, body.completedAt)
  return stopped ? { ...body, state: 'interrupted', outcome: 'cancellation' } : body
}
