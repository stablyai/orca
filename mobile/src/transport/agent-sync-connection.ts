// Why: binds the two agent snapshot caches to one runtime connection. It owns
// exactly ONE `runtime.clientEvents.subscribe` handle per connection, routes
// catalog/reference change events into the caches' single-flight refetch,
// hydrates both caches on every 'connected' transition (reconnect always does a
// full hydrate), and on dispose tears the subscription down and clears both
// caches (disconnect / logout / host-switch / connection replacement).
import type { RpcClient } from './rpc-client'
import type { SnapshotSyncConnection } from './revisioned-snapshot-sync'
import { agentCatalogSync } from './agent-catalog-sync'
import { agentReferenceSync } from './agent-reference-sync'

export type AgentSyncTarget = {
  openConnection: (hostId: string, client: RpcClient) => SnapshotSyncConnection
  clear: (hostId: string) => void
}

export type AgentSyncTargets = {
  catalog: AgentSyncTarget
  reference: AgentSyncTarget
}

export type AgentSyncHandle = {
  dispose: () => void
}

const DEFAULT_TARGETS: AgentSyncTargets = {
  catalog: agentCatalogSync,
  reference: agentReferenceSync
}

type ClientEventMessage = {
  type?: unknown
  subscriptionId?: unknown
  revision?: unknown
}

export function mountAgentSync(
  client: RpcClient,
  hostId: string,
  targets: AgentSyncTargets = DEFAULT_TARGETS
): AgentSyncHandle {
  const catalogConn = targets.catalog.openConnection(hostId, client)
  const referenceConn = targets.reference.openConnection(hostId, client)

  let subscriptionId: string | null = null
  let disposed = false

  function hydrate(): void {
    catalogConn.hydrate()
    referenceConn.hydrate()
  }

  function unsubscribeServer(id: string): void {
    // The client may already be closed when dispose races a disconnect;
    // sendRequest rejects immediately in that case and server-side cleanup
    // happens on connection close anyway.
    if (client.getState() === 'connected') {
      client.sendRequest('runtime.clientEvents.unsubscribe', { subscriptionId: id }).catch(() => {})
    }
  }

  const unsubscribeState = client.onStateChange((state) => {
    if (!disposed && state === 'connected') {
      hydrate()
    }
  })
  if (client.getState() === 'connected') {
    hydrate()
  }

  const unsubscribeStream = client.subscribe(
    'runtime.clientEvents.subscribe',
    null,
    (data: unknown) => {
      const event = data as ClientEventMessage
      if (event.type === 'ready') {
        subscriptionId = typeof event.subscriptionId === 'string' ? event.subscriptionId : null
        // Readiness can arrive after dispose (unmount races the open); if so,
        // release the server listener and local stream now that we have the id.
        if (disposed) {
          if (subscriptionId) {
            unsubscribeServer(subscriptionId)
          }
          unsubscribeStream()
        }
        return
      }
      if (event.type === 'end' || disposed) {
        return
      }
      if (event.type === 'agentCatalogChanged' && typeof event.revision === 'number') {
        catalogConn.announce(event.revision)
      } else if (event.type === 'agentReferencesChanged' && typeof event.revision === 'number') {
        referenceConn.announce(event.revision)
      }
    }
  )

  return {
    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      unsubscribeState()
      catalogConn.dispose()
      referenceConn.dispose()
      targets.catalog.clear(hostId)
      targets.reference.clear(hostId)
      if (subscriptionId) {
        unsubscribeServer(subscriptionId)
      }
      unsubscribeStream()
    }
  }
}
