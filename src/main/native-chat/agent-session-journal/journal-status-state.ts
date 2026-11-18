import type { StructuredAgentSessionWorkScope } from '../../../shared/agent-session/view/structured-agent-session-main-agent-working'
import { projectStructuredAgentSessionStatusState } from '../../../shared/agent-session/view/structured-agent-session-projection'
import type { JournalReducerState } from './projection/journal-reducer'
import { renderJournalStatus } from './projection/journal-public-read'
import { journalInputOrder } from './input-order/journal-input-order'
import { agentSessionCurrentContextRows } from '../../../shared/agent-session/conversation-context/agent-session-context-clear'
import { newestOpenStructuredAgentSessionAsyncQuestion } from '../../../shared/agent-session/view/structured-agent-session-async-questions'

export type JournalStatusState = ReturnType<typeof projectStructuredAgentSessionStatusState>

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
