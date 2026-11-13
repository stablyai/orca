import { sessionCrewChanges } from '../../orchestration/crew/crew-changes'
import type { AgentSessionStoreState } from './agent-session-store-state'
import type { AgentSessionStoreRowWrites } from './agent-session-store-draft'

export function publishAgentSessionCrewChanges(
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
    const affected = new Set([...writes.records.remove, ...writes.records.upsert.map(([id]) => id)])
    if (writes.sessionTabs) {
      for (const id of [
        ...(published.sessionTabs?.sessionIds() ?? []),
        ...(draft.sessionTabs?.sessionIds() ?? [])
      ]) {
        if (published.sessionTabs?.tabIdFor(id) !== draft.sessionTabs?.tabIdFor(id)) {
          affected.add(id)
        }
      }
    }
    sessionCrewChanges.notify(
      Object.assign(new Set(['records'] as const), {
        recordIds: [...affected],
        trafficAddresses: new Set([...affected].map((id) => `orca_session_id:${id}`))
      })
    )
  } else if (renamed.length) {
    sessionCrewChanges.notify(Object.assign(new Set(['names'] as const), { recordIds: renamed }))
  }
}
