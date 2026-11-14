import type { StructuredAgentSessionWorkScope } from '../../../shared/agent-session/view/structured-agent-session-main-agent-working'
import { activeStructuredAgentSessionTurnId } from '../../../shared/agent-session/view/structured-agent-session-live-turn'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type { JournalSqlStatusContext } from './journal-sql-status-context'
import { stopIsAPersons, type JournalLatestStop } from './context-epochs/journal-stop-turn-end'
import { readJournalSqlFirstInputId } from './journal-sql-status-inputs'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'

import type {
  JournalStatusIndicatorRead,
  JournalStatusIndicators
} from './journal-status-indicators'

export function readJournalSqlStatusIndicators(
  state: JournalSqlStatusContext,
  input: JournalStatusIndicatorRead,
  scope?: StructuredAgentSessionWorkScope,
  firstInputSubmissionKey?: string | null
): JournalStatusIndicators {
  const order = state
  const { epoch } = state
  const stop = input.stop === undefined ? state.stop : input.stop
  const failed = stop?.settle?.failedOn
  const openedAfter = failed && 'openedAfter' in failed ? failed.openedAfter : undefined
  const submissions = order.statusInputs(openedAfter)
  const first = firstInputSubmissionKey
    ? null
    : readJournalSqlFirstInputId(state, input.start, input.floor, submissions)
  return {
    acceptedSendKey: `${epoch}:${submissions.findLast((send) => send.dispatchState === 'accepted')?.clientMessageId ?? ''}`,
    firstInputSubmissionKey:
      firstInputSubmissionKey ?? (first === null ? null : JSON.stringify([epoch, first])),
    submissionCount: order.submissionCount,
    stopping: readJournalStopping(state, stop, submissions, scope)
  }
}

function readJournalStopping(
  state: JournalSqlStatusContext,
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
  const boundary = state.select({ kind: 'boundary' })[Symbol.iterator]().next().value?.item
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
  const first = state
    .select({
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
