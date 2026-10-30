import { vi, type Mock, type MockInstance } from 'vitest'
import { AgentHookServer } from '../agent-hooks/server'
import { agentHookRuntimeDeps } from '../agent-hooks/agent-hook-runtime-deps'
import { AgentStatusObservedPaneIdentities } from './agent-status-observed-pane-identity'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { hostTestState } from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { scaleStore } from './agent-session-scale.test-fixture'
import { makeStructuredAgentStatusSubject } from '../../shared/agent-status-subject'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import type { AgentStatusStore } from '../../shared/agent-status-store'

class CountedServer extends AgentHookServer {
  builds = 0
  storeForContract() {
    return this.canonicalStatusStore
  }
  listingForContract() {
    return this.canonicalListingOrder
  }
  subjectsForContract() {
    return this.canonicalSubjectsByPane
  }
  protected override buildStatusChangeNotification() {
    this.builds++
    return super.buildStatusChangeNotification()
  }
}

export async function savedRosterRig(n: number) {
  const rig = await scaleStore(n)
  const ids = rig.rows.slice(0, n).map((row) => row.sessionId)
  for (const id of ids) {
    await rig.store.transitionHandoff(id, (record) => ({
      ...record,
      lastTurn: { state: 'settled', outcome: 'success', at: 100 },
      lease: {
        ...record.lease,
        claimStatus: 'released',
        ownerProcess: null,
        reservedSpawnToken: null,
        handoffStage: null,
        unreconciled: false
      }
    }))
  }
  const server = new CountedServer()
  const sink = agentHookRuntimeDeps(
    server,
    new AgentStatusObservedPaneIdentities(),
    () => ({})
  ).structuredAgentStatusSink
  const host = new StructuredAgentSessionHost({
    ...hostTestState().host.deps,
    store: rig.store,
    recoveryCapsule: undefined,
    statusSink: sink
  })
  const location = rig.rows[0]!.location
  function live(id = 'live-session', status: AgentSessionStatusSummary['status'] = 'working') {
    server.ingestStructuredStatus(
      {
        sessionId: id,
        workspaceId: location.workspaceId,
        agent: 'claude',
        status,
        latestPrompt: 'live input',
        providerSession: { key: 'session_id', id: `provider-${id}` },
        statusStartedAt: 200,
        updatedAt: 200
      },
      makeStructuredAgentStatusSubject(location, id)
    )
  }
  return { ...rig, ids, server, sink, host, live }
}

type RosterWork = {
  counts: { parentVisits: number; enumerations: number }
  revision: MockInstance<AgentStatusStore['getRevision']>
  mutation: MockInstance<AgentStatusStore['applyMutation']>
  snapshots: MockInstance<AgentStatusStore['getSnapshot']>
  listing: MockInstance<ReturnType<CountedServer['listingForContract']>['set']>
  subjects: MockInstance<ReturnType<CountedServer['subjectsForContract']>['set']>
  rows: Mock<Parameters<AgentHookServer['subscribeStatusRowMutations']>[0]>
  enriched: Mock<Parameters<AgentHookServer['subscribeEnrichedStatus']>[0]>
}

export function countRosterWork(server: CountedServer): RosterWork {
  const store = server.storeForContract()
  const counts = { parentVisits: 0, enumerations: 0 }
  const parents = store.getParents
  vi.spyOn(store, 'getParents').mockImplementation(() => {
    const rows = parents()
    counts.enumerations++
    counts.parentVisits += rows.length
    return rows
  })
  return {
    counts,
    revision: vi.spyOn(store, 'getRevision'),
    mutation: vi.spyOn(store, 'applyMutation'),
    snapshots: vi.spyOn(store, 'getSnapshot'),
    listing: vi.spyOn(server.listingForContract(), 'set'),
    subjects: vi.spyOn(server.subjectsForContract(), 'set'),
    rows: vi.fn<Parameters<AgentHookServer['subscribeStatusRowMutations']>[0]>(),
    enriched: vi.fn<Parameters<AgentHookServer['subscribeEnrichedStatus']>[0]>()
  }
}
