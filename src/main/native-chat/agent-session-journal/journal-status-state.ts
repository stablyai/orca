import type { StructuredAgentSessionWorkScope } from '../../../shared/agent-session/view/structured-agent-session-main-agent-working'
import { projectStructuredAgentSessionStatusState } from '../../../shared/agent-session/view/structured-agent-session-projection'
import type { AgentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import type { JournalReducerState } from './projection/journal-reducer'
import { renderJournalStatus } from './projection/journal-public-read'
import { journalInputOrder } from './input-order/journal-input-order'
import { agentSessionCurrentContextRows } from '../../../shared/agent-session/conversation-context/agent-session-context-clear'
import { newestOpenStructuredAgentSessionAsyncQuestion } from '../../../shared/agent-session/view/structured-agent-session-async-questions'

/** Settled root turns behind a quiet latest request, newest first: where each turn's
 *  row sits and whether it said something a merged quiet end would drop. */
export type JournalTurnsBehind = {
  turns: readonly { id: string; sequence: number; answered: boolean }[]
  /** The window filled; older settled turns may sit behind it. */
  more: boolean
}

export type JournalStatusState = ReturnType<typeof projectStructuredAgentSessionStatusState> & {
  /** Why the settled latest request failed, typed; absent unless its verdict is a failure. */
  turnFailure?: AgentSessionFailureFact
  /** The newest answer is a bot's quiet marker. */
  quietAnswer?: true
  turnsBehind?: JournalTurnsBehind
  /** Set by the host: the latest request ended in a way its host keeps quiet. */
  quiet?: true
}

/** The original array projection remains the compatibility oracle. */
export function readJournalStatusState(
  state: JournalReducerState,
  currentFence?: number | null,
  scope?: StructuredAgentSessionWorkScope
): JournalStatusState {
  const snapshot = renderJournalStatus(state, journalInputOrder(state))
  const projected = projectStructuredAgentSessionStatusState(
    snapshot.items,
    snapshot.submissions,
    currentFence,
    scope,
    snapshot.item
  )
  const current = agentSessionCurrentContextRows(snapshot.items, snapshot.submissions)
  const openAsyncQuestion =
    projected.summary.status !== null
      ? newestOpenStructuredAgentSessionAsyncQuestion(current.items, current.submissions)
      : undefined
  return openAsyncQuestion
    ? { ...projected, summary: { ...projected.summary, openAsyncQuestion } }
    : projected
}
