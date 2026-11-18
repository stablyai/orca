import os from 'node:os'
import { isTuiAgent } from '../../../shared/agent-launch/catalog/tui-agent-config'
import { computeZotzMemoryGovernorDefaults } from '../../../shared/zotz/agent-queue/zotz-memory-governor-defaults'
import type { agentHookServer as AgentHookServerInstance } from '../../agent-hooks/server/agent-hook-server'
import { collectMemorySnapshot, type MemorySnapshotStore } from '../../memory/collector'
import { collectHostMemory } from '../../memory/host-memory'
import { listRegisteredPtys } from '../../memory/pty-registry'
import { ZotzAgentQueueStore } from '../zotz-agent-queue-store'
import { ZotzAgentMemorySampler, type ZotzLiveAgentPane } from './zotz-agent-memory-sampler'
import { ZotzMemoryGovernorService } from './zotz-memory-governor-service'
import { ZotzAgentLaunchQueue } from './zotz-agent-launch-queue'
import { setZotzAgentLaunchQueue } from './zotz-agent-launch-hold'
import { registerZotzAgentQueueHandlers } from './zotz-agent-queue-ipc'

let governor: ZotzMemoryGovernorService | null = null

export function getZotzMemoryGovernor(): ZotzMemoryGovernorService | null {
  return governor
}

/** Agent terminals this host runs: a hook-reported agent whose pane has a live local PTY. */
function listLocalAgentPanes(server: typeof AgentHookServerInstance): ZotzLiveAgentPane[] {
  const localPanes = new Set(
    listRegisteredPtys().flatMap((pty) => (pty.paneKey ? [pty.paneKey] : []))
  )
  const panes = new Map<string, ZotzLiveAgentPane>()
  for (const row of server.getStatusSnapshot()) {
    if (row.providerSessionOnly || !localPanes.has(row.paneKey) || !isTuiAgent(row.agentType)) {
      continue
    }
    panes.set(row.paneKey, {
      paneKey: row.paneKey,
      agent: row.agentType,
      state: row.state,
      worktreeId: row.worktreeId ?? null
    })
  }
  return [...panes.values()]
}

async function measureLocalPanes(store: MemorySnapshotStore): Promise<Map<string, number>> {
  const snapshot = await collectMemorySnapshot(store)
  const byPane = new Map<string, number>()
  for (const worktree of snapshot.worktrees) {
    for (const session of worktree.sessions) {
      if (session.paneKey) {
        byPane.set(session.paneKey, (byPane.get(session.paneKey) ?? 0) + session.memory)
      }
    }
  }
  return byPane
}

export function startZotzMemoryGovernor(input: {
  store: MemorySnapshotStore
  server: typeof AgentHookServerInstance
  userDataPath: string
}): () => void {
  const queueStore = new ZotzAgentQueueStore(input.userDataPath)
  const service = new ZotzMemoryGovernorService({
    sampler: new ZotzAgentMemorySampler({
      listAgentPanes: () => listLocalAgentPanes(input.server),
      measurePanes: () => measureLocalPanes(input.store),
      now: Date.now
    }),
    collectHost: collectHostMemory,
    limits: computeZotzMemoryGovernorDefaults(os.totalmem()),
    loadLedger: () => queueStore.loadLedger(),
    saveLedger: (ledger) => queueStore.saveLedger(ledger),
    now: Date.now
  })
  governor = service
  const launchQueue = new ZotzAgentLaunchQueue(service)
  setZotzAgentLaunchQueue(launchQueue)
  const unregisterIpc = registerZotzAgentQueueHandlers(service, launchQueue)
  void service.start()
  const unsubscribe = input.server.subscribeStatusRowMutations(() => service.wake())
  return () => {
    unsubscribe()
    unregisterIpc()
    service.dispose()
    setZotzAgentLaunchQueue(null)
    if (governor === service) {
      governor = null
    }
  }
}
