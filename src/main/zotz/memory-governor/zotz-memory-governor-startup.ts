import os from 'node:os'
import { computeZotzMemoryGovernorDefaults } from '../../../shared/zotz/agent-queue/zotz-memory-governor-defaults'
import type { agentHookServer as AgentHookServerInstance } from '../../agent-hooks/server/agent-hook-server'
import type { MemorySnapshotStore } from '../../memory/collector'
import { collectHostMemory } from '../../memory/host-memory'
import type { Store } from '../../persistence/loading-store/store'
import { ZotzAgentQueueStore } from '../zotz-agent-queue-store'
import { ZotzAgentMemorySampler } from './zotz-agent-memory-sampler'
import { listZotzAgentProcessRoots, measureZotzAgentProcessRoots } from './zotz-agent-process-roots'
import { ZotzMemoryGovernorService } from './zotz-memory-governor-service'
import { collectZotzHostMemory, createZotzSystemPressureReader } from './zotz-darwin-memory-signals'
import { ZotzAgentLaunchQueue } from './zotz-agent-launch-queue'
import { setZotzAgentLaunchQueue } from './zotz-agent-launch-hold'
import { registerZotzAgentQueueHandlers } from './zotz-agent-queue-ipc'
import { registerZotzAgentQueueSource } from './zotz-agent-queue-source'

let governor: ZotzMemoryGovernorService | null = null

export function getZotzMemoryGovernor(): ZotzMemoryGovernorService | null {
  return governor
}

export function startZotzMemoryGovernor(input: {
  store: MemorySnapshotStore & Pick<Store, 'getSettings' | 'onSettingsChanged'>
  server: typeof AgentHookServerInstance
  userDataPath: string
}): () => void {
  const queueStore = new ZotzAgentQueueStore(input.userDataPath)
  const service = new ZotzMemoryGovernorService({
    sampler: new ZotzAgentMemorySampler({
      listAgentPanes: () =>
        listZotzAgentProcessRoots(input.server.getStatusSnapshot()).map(
          ({ pid: _pid, ...pane }) => pane
        ),
      measurePanes: () =>
        measureZotzAgentProcessRoots(listZotzAgentProcessRoots(input.server.getStatusSnapshot())),
      now: Date.now
    }),
    collectHost: () => collectZotzHostMemory(collectHostMemory),
    readSystemPressure: createZotzSystemPressureReader(),
    limits: computeZotzMemoryGovernorDefaults(os.totalmem()),
    loadLedger: () => queueStore.loadLedger(),
    saveLedger: (ledger) => queueStore.saveLedger(ledger),
    now: Date.now
  })
  governor = service
  const launchQueue = new ZotzAgentLaunchQueue(service)
  setZotzAgentLaunchQueue(launchQueue)
  launchQueue.setEnabled(input.store.getSettings().zotzAgentQueueEnabled !== false)
  const stopSettingsSync = input.store.onSettingsChanged((updates) => {
    if ('zotzAgentQueueEnabled' in updates) {
      launchQueue.setEnabled(updates.zotzAgentQueueEnabled !== false)
    }
  })
  const unregisterIpc = registerZotzAgentQueueHandlers(service, launchQueue)
  const unregisterSource = registerZotzAgentQueueSource({ governor: service, queue: launchQueue })
  void service.start()
  const unsubscribe = input.server.subscribeStatusRowMutations(() => service.wake())
  return () => {
    unsubscribe()
    unregisterIpc()
    unregisterSource()
    stopSettingsSync()
    service.dispose()
    setZotzAgentLaunchQueue(null)
    if (governor === service) {
      governor = null
    }
  }
}
