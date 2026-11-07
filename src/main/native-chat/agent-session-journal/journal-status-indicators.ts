import type { StructuredAgentSessionWorkScope } from '../../../shared/agent-session/view/structured-agent-session-main-agent-working'
import { activeStructuredAgentSessionTurnId } from '../../../shared/agent-session/view/structured-agent-session-live-turn'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import type { JournalReducerState } from './projection/journal-reducer'
import { journalInputOrder } from './input-order/journal-input-order'
import { journalContextCursor } from './context-epochs/journal-context-cursor'
import { stopIsAPersons, type JournalLatestStop } from './context-epochs/journal-stop-turn-end'
import { readJournalFirstInputId } from './journal-status-inputs'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'

export type JournalStatusIndicatorRead = {
  start: number
  floor: number
  /** The host's row-free settlement state accompanies its latest persisted Stop. */
  stop?: JournalLatestStop | null
}

export type JournalStatusIndicators = {
  acceptedSendKey: string
  firstInputSubmissionKey: string | null
  submissionCount: number
  stopping: boolean
}

export function readJournalStatusIndicators(
  state: JournalReducerState,
  input: JournalStatusIndicatorRead,
  scope?: StructuredAgentSessionWorkScope
): JournalStatusIndicators {
  const order = journalInputOrder(state)
  const { epoch } = journalContextCursor(state)
  const stop = input.stop === undefined ? state.queuePauseMarks.latestStop : input.stop
  const failed = stop?.settle?.failedOn
  const openedAfter = failed && 'openedAfter' in failed ? failed.openedAfter : undefined
  const submissions = order.statusInputs(state, [], openedAfter)
  const first = readJournalFirstInputId(state, input.start, input.floor, submissions)
  return {
    acceptedSendKey: `${epoch}:${submissions.findLast((send) => send.dispatchState === 'accepted')?.clientMessageId ?? ''}`,
    firstInputSubmissionKey: first === null ? null : JSON.stringify([epoch, first]),
    submissionCount: order.inputCount(),
    stopping: readJournalStopping(state, stop, submissions, scope)
  }
}

function readJournalStopping(
  state: JournalReducerState,
  stop: JournalLatestStop | null,
  submissions: readonly AgentJournalSubmission[],
  scope?: StructuredAgentSessionWorkScope
): boolean {
  if (stop === null || !stopIsAPersons(stop.event.reason)) {
    return false
  }
  if (stop.settle?.settling === true) {
    return true
  }
  const failed = stop.settle?.failedOn
  const bound =
    stop.event.turnId ??
    stop.settle?.turnId ??
    (failed && 'turnId' in failed ? failed.turnId : undefined)
  const boundary = state.queries.statusItems(state, { kind: 'boundary' })[Symbol.iterator]().next()
    .value?.item
  const live = activeStructuredAgentSessionTurnId(
    boundary ? [boundary] : [],
    scope && ((item) => scope.isCurrentItem(item.itemId))
  )
  if (bound !== undefined) {
    return bound === live
  }
  if (!failed || !('openedAfter' in failed)) {
    return false
  }
  const sentSince = submissions.reduce((first, send) => {
    const at = send.acceptedSequence
    return send.dispatchState !== 'rejected' && at !== undefined && at > failed.openedAfter
      ? Math.min(first, at)
      : first
  }, Infinity)
  const first = state.queries
    .statusItems(state, {
      kind: 'turns',
      floor: failed.openedAfter,
      before: sentSince,
      direction: 'asc',
      first: true
    })
    [Symbol.iterator]()
    .next().value?.item
  const firstTurn = readAgentJournalTurn(first?.body)?.turnId ?? null
  return firstTurn === null ? sentSince === Infinity : firstTurn === live
}
