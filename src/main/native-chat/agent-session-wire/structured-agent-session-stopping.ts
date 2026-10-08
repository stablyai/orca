// Whether a chat reads "Stopping…": a person's Stop is still settling, or the turn it stopped, or
// failed to stop, still runs. The host reads it on each journal commit and each settle edge from
// the Stop's event and what its settle bound (`journal-stop-turn-end.ts`), so nothing is stored
// and it clears when that turn ends. A Stop that settled having stopped nothing binds no turn, so
// a later one never reads Stopping. Clients only present it.

import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-live-turn'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { stopIsAPersons } from '../agent-session-journal/journal-stop-turn-end'
import type { JournalStopFailedOn } from '../agent-session-journal/queued-message-pause'

/** Whether the latest person's Stop is still settling, or is bound to the turn running now: the
 *  one it named, the one its settle bound, or the one it failed to stop. */
export function structuredAgentSessionStopping(
  journal: Pick<AgentSessionJournal, 'stopMarks'>,
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = []
): boolean {
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
  const live = activeStructuredAgentSessionTurnId(items)
  if (bound !== undefined) {
    return bound === live
  }
  if (failed && 'openedAfter' in failed) {
    // Only what was in flight when it failed: a send handed over since opens its own turn.
    const sentSince = firstSendHandedOverAfter(submissions, failed.openedAfter)
    const first = firstTurnOpenedAfter(items, failed.openedAfter, sentSince)
    return first === null ? sentSince === Infinity : first === live
  }
  return false
}

/** Where the first send handed over after `sequence` was, or Infinity when none was. */
function firstSendHandedOverAfter(
  submissions: readonly AgentJournalSubmission[],
  sequence: number
): number {
  let first = Infinity
  for (const submission of submissions) {
    const at = submission.acceptedSequence
    if (submission.dispatchState !== 'rejected' && at !== undefined && at > sequence) {
      first = Math.min(first, at)
    }
  }
  return first
}

/** Where a Stop that failed leaves "Stopping…" (display only): the turn running now, or, with
 *  none, the first that opens after this position. */
export function structuredAgentSessionFailedStopMark(
  journal: Pick<AgentSessionJournal, 'activeTurnId' | 'cursor'>
): JournalStopFailedOn {
  const live = journal.activeTurnId()
  return live !== null ? { turnId: live } : { openedAfter: journal.cursor().sequence }
}

/** The first turn whose row was created after `sequence` and before `before`, read from the tail
 *  back to `sequence`. */
function firstTurnOpenedAfter(
  items: readonly AgentJournalRenderItem[],
  sequence: number,
  before: number
): string | null {
  let first: string | null = null
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (!item || item.sequence <= sequence) {
      break
    }
    const turnId = item.sequence < before ? readAgentJournalTurn(item.body)?.turnId : undefined
    first = turnId ?? first
  }
  return first
}
