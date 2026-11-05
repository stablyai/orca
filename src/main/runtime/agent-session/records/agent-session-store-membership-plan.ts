import type { JournalPersistencePlan } from '../../../native-chat/agent-session-journal/journal-persistence-plan'
import type { AgentSessionStoreState } from './agent-session-store-state'
import type { AgentSessionStoreRowWrites } from './agent-session-store-draft'
import { AgentSessionTabTable } from '../agent-session-tab-table'

export function stageAgentSessionMembership(
  plan: JournalPersistencePlan,
  before: AgentSessionStoreState,
  draft: AgentSessionStoreState,
  writes: AgentSessionStoreRowWrites | null
): void {
  if (!writes?.sessionTabs) {
    return
  }
  plan.memberships.push({
    before: (before.sessionTabs?.entries() ?? []).map(([tabId, sessionId]) => ({
      tabId,
      sessionId
    })),
    after: writes.sessionTabs.tabs,
    adopt: (tabs) => {
      draft.sessionTabs = new AgentSessionTabTable(
        tabs.map(({ tabId, sessionId }) => [tabId, sessionId])
      )
    }
  })
}
