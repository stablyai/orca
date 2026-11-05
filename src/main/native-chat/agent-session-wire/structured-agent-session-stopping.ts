import { activeStructuredAgentSessionTurnIdSteps } from '../../../shared/agent-session/view/structured-agent-session-live-turn'
import { finishAgentSessionSteps } from '../../../shared/agent-session/agent-session-projection-steps'
// Derive Stopping from the Stop event and settlement; clear it when the bound turn ends.
// A settled no-op binds no turn, so later work cannot inherit Stopping.

import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'

import type { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import type { StructuredAgentSessionWorkScope } from '../../../shared/agent-session/view/structured-agent-session-main-agent-working'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { stopIsAPersons } from '../agent-session-journal/journal-stop-turn-end'
import type { JournalStopFailedOn } from '../agent-session-journal/queued-message-pause'

export function structuredAgentSessionStopping(
  journal: Pick<AgentSessionJournal, 'stopMarks'>,
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = [],
  scope?: StructuredAgentSessionWorkScope
): boolean {
  return finishAgentSessionSteps(
    structuredAgentSessionStoppingSteps(journal, items, submissions, scope)
  )
}

export function* structuredAgentSessionStoppingSteps(
  journal: Pick<AgentSessionJournal, 'stopMarks'>,
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = [],
  scope?: StructuredAgentSessionWorkScope
): Generator<void, boolean> {
  const stop = journal.stopMarks.latest()
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
  const live = yield* activeStructuredAgentSessionTurnIdSteps(
    items,
    scope && ((item) => scope.isCurrentItem(item.itemId))
  )
  if (bound !== undefined) {
    return bound === live
  }
  if (failed && 'openedAfter' in failed) {
    // Later handed-over sends open independent turns and cannot inherit this failed Stop.
    const sentSince = yield* firstSendHandedOverAfterSteps(submissions, failed.openedAfter)
    const first = yield* firstTurnOpenedAfterSteps(items, failed.openedAfter, sentSince)
    return first === null ? sentSince === Infinity : first === live
  }
  return false
}

export function* firstSendHandedOverAfterSteps(
  submissions: readonly AgentJournalSubmission[],
  sequence: number
): Generator<void, number> {
  let first = Infinity
  for (const submission of submissions) {
    yield

    const at = submission.acceptedSequence
    if (submission.dispatchState !== 'rejected' && at !== undefined && at > sequence) {
      first = Math.min(first, at)
    }
  }
  return first
}

/** Display-only failed Stop binding: current turn, or the first opening after this position. */
export function structuredAgentSessionFailedStopMark(
  work: Pick<StructuredAgentSessionCurrentWork, 'activeTurnId'>,
  journal: Pick<AgentSessionJournal, 'cursor'>
): JournalStopFailedOn {
  const live = work.activeTurnId()
  return live !== null ? { turnId: live } : { openedAfter: journal.cursor().sequence }
}

export function* firstTurnOpenedAfterSteps(
  items: readonly AgentJournalRenderItem[],
  sequence: number,
  before: number
): Generator<void, string | null> {
  let first: string | null = null
  for (let index = items.length - 1; index >= 0; index -= 1) {
    yield

    const item = items[index]
    if (!item || item.sequence <= sequence) {
      break
    }
    const turnId = item.sequence < before ? readAgentJournalTurn(item.body)?.turnId : undefined
    first = turnId ?? first
  }
  return first
}
