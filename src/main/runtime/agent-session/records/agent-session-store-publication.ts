import type { AgentSessionStoreState } from './agent-session-store-state'
import type { AgentSessionStoreRowWrites } from './agent-session-store-draft'
import type { JournalHostDatabase } from '../../../native-chat/agent-session-journal/journal-host-database'
import { sessionCrewChanges } from '../../orchestration/crew/crew-changes'

export function publishAgentSessionStoreChanges(
  journalDatabase: JournalHostDatabase,
  published: AgentSessionStoreState,
  draft: AgentSessionStoreState,
  writes: AgentSessionStoreRowWrites
): void {
  const topologyChanged =
    writes.sessionTabs !== null ||
    writes.records.remove.length > 0 ||
    writes.records.upsert.some(([id]) => {
      const before = published.records.get(id)
      const after = draft.records.get(id)
      return (
        !before ||
        !after ||
        before.lease.claimStatus !== after.lease.claimStatus ||
        before.provider !== after.provider ||
        before.location !== after.location ||
        before.conversationCommand !== after.conversationCommand
      )
    })
  const renamed = writes.records.upsert
    .filter(
      ([id]) =>
        published.records.get(id)?.conversationName !== draft.records.get(id)?.conversationName
    )
    .map(([id]) => id)
  if (topologyChanged) {
    journalDatabase.notifyCommitted(() => sessionCrewChanges.notify(new Set(['records'])))
  } else if (renamed.length) {
    journalDatabase.notifyCommitted(() =>
      sessionCrewChanges.notify(Object.assign(new Set(['names'] as const), { recordIds: renamed }))
    )
  }
}
