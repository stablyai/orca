import { journalInputOrder } from './journal-input-order'
// A person's accepted Stop withdraws its work's automatic continuation whichever commits first:
// its acceptance, or the limited end. Settlement binds turns that had no ID when Stop was accepted.

import { readAgentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { UsageLimitContinueIdentity } from '../../../shared/agent-session/lifecycle/agent-session-usage-limit-continue'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'

function mayEndWork(body: AgentJournalItemBody): boolean {
  const turn = readAgentJournalTurn(body)
  return turn
    ? turn.state !== 'running'
    : body.kind === 'status' &&
        readAgentSessionFailureFact(body.failure)?.kind === 'usageLimitReached'
}

/** Ends, limit evidence and settled sends can reveal a cut; streamed output cannot. */
function mayRevealCut(row: JournalRow): boolean {
  switch (row.kind) {
    case 'item':
      return mayEndWork(row.body)
    case 'lifecycle-batch':
      return row.mutations.some((mutation) => mutation.kind === 'item' && mayEndWork(mutation.body))
    case 'dispatch':
      return true
    case 'epoch':
    case 'tombstone':
    case 'submission':
    case 'queue':
      return false
  }
}

/** The known-reset cut this commit leaves for work the latest personal Stop withdrew. */
export function journalStoppedUsageLimitCut(
  state: JournalReducerState,
  rows: readonly JournalRow[],
  _previous: JournalReducerState = state,
  _withdrawn?: UsageLimitContinueIdentity
): UsageLimitContinueIdentity | undefined {
  if (
    !rows.some(
      (row) =>
        (row.kind === 'tombstone' && row.stopEvent?.reason === 'user-stop') || mayRevealCut(row)
    )
  ) {
    return undefined
  }
  const input = journalInputOrder(state)
  if (input.sendingSubmissions().length > 0) {
    return undefined
  }
  const cut = input.newestTurn.usageLimitCut.read()
  const turnId = cut && readAgentJournalTurn(state.items.get(cut.turnItemId)?.body)?.turnId
  return cut &&
    turnId !== undefined &&
    state.derivedTurnScope.cancellations.history(state, turnId)?.userStop
    ? cut
    : undefined
}
