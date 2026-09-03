import {
  REMOTE_WORKSPACE_CHANGED_NOTIFICATION,
  REMOTE_WORKSPACE_STALE_NOTIFICATION
} from '../shared/remote-workspace-types'
import type { RelayDispatcher } from './dispatcher'
import {
  createRelayClientResyncMarkerPublisher,
  type RelayClientResyncMarkerPublisher
} from './relay-client-resync-marker'

const stalePublishers = new WeakMap<RelayDispatcher, RelayClientResyncMarkerPublisher>()

function stalePublisher(dispatcher: RelayDispatcher): RelayClientResyncMarkerPublisher {
  const existing = stalePublishers.get(dispatcher)
  if (existing) {
    return existing
  }
  const publisher = createRelayClientResyncMarkerPublisher(
    dispatcher,
    REMOTE_WORKSPACE_STALE_NOTIFICATION
  )
  stalePublishers.set(dispatcher, publisher)
  return publisher
}

/**
 * Per client, because frame capacity is per client: one peer on a small sink must not cost the
 * others their snapshot, and a peer that cannot take the snapshot still learns it is behind.
 * The marker deliberately carries no revision or author — a coalesced marker would then replay a
 * generation the producer has moved past, which is the same silent staleness this exists to remove.
 */
export function publishWorkspaceSnapshotChange(
  dispatcher: RelayDispatcher,
  params: Record<string, unknown>,
  namespace: string
): void {
  for (const clientId of dispatcher.activeClientIds()) {
    if (
      dispatcher.publishProducerNotification(
        clientId,
        REMOTE_WORKSPACE_CHANGED_NOTIFICATION,
        params
      )
    ) {
      continue
    }
    stalePublisher(dispatcher).emit(clientId, namespace, { namespace })
  }
}
