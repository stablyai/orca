// A person's accepted Stop withdraws its work's automatic continuation whichever commits first:
// its acceptance, or the limited end. Settlement binds turns that had no ID when Stop was accepted.

import { readAgentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { UsageLimitContinueIdentity } from '../../../shared/agent-session/lifecycle/agent-session-usage-limit-continue'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { newestStructuredAgentSessionTurnBySequence } from '../../../shared/agent-session/view/structured-agent-session-live-turn'
import { latestUsageLimitContinueIdentity } from '../../../shared/native-chat/native-chat-usage-limit-cut'
import type { JournalReducerState } from './journal-reducer'
import { renderJournalStatus } from './journal-public-read'
import { journalInputOrder } from './journal-input-order-owner'
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
  rows: readonly JournalRow[]
): UsageLimitContinueIdentity | undefined {
  const stop = state.queuePauseMarks.latestStop
  if (stop?.event.reason !== 'user-stop') {
    return undefined
  }
  // Acceptance withdraws the latest cut, including one its own withdrawals reveal.
  const accepting = rows.some((row) => row.seq === stop.sequence)
  const owns = (turnId: string | undefined): boolean =>
    accepting ||
    stop.settle?.settling === true ||
    (turnId !== undefined && (turnId === stop.settle?.turnId || turnId === stop.event.turnId))
  if (!accepting) {
    const newest = rows.some(mayRevealCut)
      ? newestStructuredAgentSessionTurnBySequence(state.items.values())
      : null
    if (!newest || newest.state === 'running' || !owns(newest.turnId)) {
      return undefined
    }
  }
  const cut = latestUsageLimitContinueIdentity(renderJournalStatus(state, journalInputOrder(state)))
  return cut && owns(readAgentJournalTurn(state.items.get(cut.turnItemId)?.body)?.turnId)
    ? cut
    : undefined
}
