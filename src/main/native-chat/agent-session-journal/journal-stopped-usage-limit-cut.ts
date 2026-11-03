// A person's accepted Stop withdraws its work's automatic continuation whichever commits first:
// its acceptance, or the limited end. Settlement binds turns that had no ID when Stop was accepted.

import {
  agentJournalItemKey,
  agentJournalStopNoteIdentity
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { readAgentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { UsageLimitContinueIdentity } from '../../../shared/agent-session/lifecycle/agent-session-usage-limit-continue'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { newestStructuredAgentSessionTurnBySequence } from '../../../shared/agent-session/view/structured-agent-session-live-turn'
import { latestUsageLimitContinueIdentity } from '../../../shared/native-chat/native-chat-usage-limit-cut'
import { renderJournalState, type JournalReducerState } from './journal-reducer'
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
  previous: JournalReducerState = state,
  withdrawn?: UsageLimitContinueIdentity
): UsageLimitContinueIdentity | undefined {
  const accepting = rows.some(
    (row) => row.kind === 'tombstone' && row.stopEvent?.reason === 'user-stop'
  )
  if (!accepting && !rows.some(mayRevealCut)) {
    return undefined
  }
  const stops = [
    ...(state.queuePauseMarks.pendingCancellations ?? []),
    ...(previous.queuePauseMarks.pendingCancellations ?? [])
  ].filter((stop) => stop.event.reason === 'user-stop')
  const withdrawnTurn = withdrawn
    ? readAgentJournalTurn(state.items.get(withdrawn.turnItemId)?.body)?.turnId
    : undefined
  const requested = (turnId: string): boolean => {
    const note = state.items.get(agentJournalItemKey(agentJournalStopNoteIdentity(turnId)))
    return (
      note?.turnScope?.kind === 'turn' &&
      readAgentJournalTurn(state.items.get(note.turnScope.turnItemId)?.body)?.turnId === turnId
    )
  }
  const owns = (turnId: string | undefined): boolean =>
    accepting ||
    (turnId !== undefined &&
      (requested(turnId) ||
        withdrawnTurn === turnId ||
        stops.some((stop) => stop.target?.turnId === turnId)))
  if (!accepting) {
    const newest = rows.some(mayRevealCut)
      ? newestStructuredAgentSessionTurnBySequence(state.items.values())
      : null
    if (!newest || newest.state === 'running' || !owns(newest.turnId)) {
      return undefined
    }
  }
  const cut = latestUsageLimitContinueIdentity(renderJournalState(state))
  return cut && owns(readAgentJournalTurn(state.items.get(cut.turnItemId)?.body)?.turnId)
    ? cut
    : undefined
}
