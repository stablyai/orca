import {
  directEndpointListedByHost,
  type HostDirectEndpointFields
} from './host-direct-endpoint-refresh'
import { mutateStoredHosts } from './host-list-mutation-queue'
import type { StoredHostProfile } from './host-profile'

/** Mark the saved endpoint as the desktop's own when it lists it; resolves to the saved fields either way. */
export function markHostDirectEndpointListed(
  hostId: string,
  endpoints: readonly string[]
): Promise<HostDirectEndpointFields | null> {
  return updateHostDirectEndpoint(hostId, (row) =>
    directEndpointListedByHost(row, endpoints) ? { ...row, directEndpointOrigin: 'host' } : row
  )
}

/** Save an address the phone just authenticated to, only over the desktop-owned endpoint it replaces. */
export function adoptHostDirectEndpoint(
  hostId: string,
  replaced: string,
  endpoint: string
): Promise<HostDirectEndpointFields | null> {
  return updateHostDirectEndpoint(hostId, (row) =>
    row.directEndpointOrigin === 'host' && row.endpoint === replaced ? { ...row, endpoint } : row
  )
}

// Resolves to the saved fields afterwards, so a caller holding a stale copy converges; null once removed.
async function updateHostDirectEndpoint(
  hostId: string,
  update: (row: StoredHostProfile) => StoredHostProfile
): Promise<HostDirectEndpointFields | null> {
  let saved: HostDirectEndpointFields | null = null
  await mutateStoredHosts((hosts) => {
    const index = hosts.findIndex((host) => host.id === hostId)
    if (index === -1) {
      return hosts
    }
    const current = hosts[index]!
    const updated = update(current)
    saved = { endpoint: updated.endpoint, directEndpointOrigin: updated.directEndpointOrigin }
    if (updated === current) {
      return hosts
    }
    const next = hosts.slice()
    next[index] = updated
    return next
  })
  return saved
}
