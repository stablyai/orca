import type { ZotzAgentLaunchQueue } from './zotz-agent-launch-queue'
import type { ZotzMemoryGovernorService } from './zotz-memory-governor-service'

export type ZotzAgentQueueSource = {
  governor: Pick<ZotzMemoryGovernorService, 'getState' | 'subscribe' | 'wake'>
  queue: Pick<
    ZotzAgentLaunchQueue,
    'list' | 'listCanceled' | 'subscribe' | 'cancel' | 'forceStart' | 'dismissCanceled'
  >
}

let source: ZotzAgentQueueSource | null = null

/** What the runtime RPC reads; kept apart from the Electron IPC so a headless server can serve it. */
export function registerZotzAgentQueueSource(next: ZotzAgentQueueSource): () => void {
  source = next
  return () => {
    if (source === next) {
      source = null
    }
  }
}

export function getZotzAgentQueueSource(): ZotzAgentQueueSource | null {
  return source
}
