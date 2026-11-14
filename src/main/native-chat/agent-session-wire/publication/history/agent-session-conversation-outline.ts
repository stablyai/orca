import { projectAgentSessionConversationOutline } from '../../../../../shared/agent-session/agent-session-conversation-outline'
import type { AgentJournalSnapshot } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { boundJournalConversationOutline } from '../../../agent-session-journal/journal-outline-budget'
import { HISTORY_PAGE_CONTENT_BUDGET_BYTES } from './agent-session-history-page-bounds'

export function readAgentSessionConversationOutline(
  snapshot: AgentJournalSnapshot,
  budgetBytes: number = HISTORY_PAGE_CONTENT_BUDGET_BYTES
) {
  return boundJournalConversationOutline(
    snapshot,
    projectAgentSessionConversationOutline(snapshot.items, snapshot.submissions),
    budgetBytes
  )
}
