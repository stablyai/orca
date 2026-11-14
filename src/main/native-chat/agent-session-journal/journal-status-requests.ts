import { hasStructuredAgentSessionRequest } from '../../../shared/agent-session/requests/structured-agent-session-latest-request'
import type { JournalReducerState } from './projection/journal-reducer'
import { renderJournalStatus } from './projection/journal-public-read'
import { journalInputOrder } from './input-order/journal-input-order'
import { readJournalStatusState } from './journal-status-state'
import type { JournalRequestStatus } from './journal-sql-status-requests'

export function readJournalRequestStatus(
  state: JournalReducerState,
  currentFence?: number | null
): JournalRequestStatus {
  const snapshot = renderJournalStatus(state, journalInputOrder(state))
  const projected = readJournalStatusState(state, currentFence)
  return {
    hasRequest: hasStructuredAgentSessionRequest(
      snapshot.items,
      snapshot.submissions,
      currentFence
    ),
    latestPrompt: projected.summary.latestPrompt,
    latestRequest: projected.latestRequest,
    ...(projected.summary.lastAssistantMessage
      ? { lastAssistantMessage: projected.summary.lastAssistantMessage }
      : {})
  }
}
