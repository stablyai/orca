import type { SurfaceExecutorAdmission } from '../../shared/workspace-surfaces/surface-executor-contract'
import type { ConnectedDaemonClient } from './daemon-client-connections'
import type { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import type { DaemonSessionAttachments } from './daemon-session-attachments'
import type { DaemonTransientFact } from './types'

export function createSurfaceExecutionEventPublisher(
  getConnections: () => Iterable<ConnectedDaemonClient>,
  getBatcher: () => DaemonStreamDataBatcher
): (admission: SurfaceExecutorAdmission) => void {
  return (admission) => {
    for (const client of getConnections()) {
      if (client.authenticatedPairEstablished) {
        getBatcher().enqueueControlEvent(client.clientId, admission.resourceId, {
          type: 'event',
          event: 'surfaceExecutionChanged',
          sessionId: admission.resourceId,
          payload: admission
        })
      }
    }
  }
}

export function createTransientFactEventPublisher(
  getAttachments: () => Pick<DaemonSessionAttachments, 'clientIdForSession'>,
  getBatcher: () => DaemonStreamDataBatcher
): (sessionId: string, fact: DaemonTransientFact) => void {
  return (sessionId, fact) => {
    const clientId = getAttachments().clientIdForSession(sessionId)
    if (clientId) {
      getBatcher().enqueueControlEvent(clientId, sessionId, {
        type: 'event',
        event: 'transientFact',
        sessionId,
        payload: fact
      })
    }
  }
}

export function sampleDaemonStreamBacklog(
  connections: Iterable<ConnectedDaemonClient>,
  batcher: Pick<DaemonStreamDataBatcher, 'queuedCharsForClient'>,
  relay: { backgroundedSessionIdSuffixes(): string[] }
) {
  return {
    clients: Array.from(connections, (client) => ({
      clientId: client.clientId,
      socketBufferedBytes: client.streamSocket?.writableLength ?? 0,
      batcherQueuedChars: batcher.queuedCharsForClient(client.clientId)
    })),
    backgroundedSessionIdSuffixes: relay.backgroundedSessionIdSuffixes()
  }
}
