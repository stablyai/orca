import type { StructuredAgentSessionWorkScope } from '../../../shared/agent-session/view/structured-agent-session-main-agent-working'
import { projectStructuredAgentSessionStatusState } from '../../../shared/agent-session/view/structured-agent-session-projection'
import type { JournalReducerState } from './projection/journal-reducer'
import { renderJournalStatus } from './projection/journal-public-read'
import { journalInputOrder } from './input-order/journal-input-order'

export type JournalStatusState = ReturnType<typeof projectStructuredAgentSessionStatusState>

/** The original array projection remains the compatibility oracle. */
export function readJournalStatusState(
  state: JournalReducerState,
  currentFence?: number | null,
  scope?: StructuredAgentSessionWorkScope
): JournalStatusState {
  const snapshot = renderJournalStatus(state, journalInputOrder(state))
  return projectStructuredAgentSessionStatusState(
    snapshot.items,
    snapshot.submissions,
    currentFence,
    scope,
    snapshot.item
  )
}
