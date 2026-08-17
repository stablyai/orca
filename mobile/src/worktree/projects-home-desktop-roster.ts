import { resolveHomeHostConnectionState } from '../transport/home-host-auto-connect'
import type { RpcClient } from '../transport/rpc-client'
import type { TransientHostClientLease } from '../transport/transient-host-client'
import type { ConnectionState, HostCatalogEntry, HostProfile } from '../transport/types'
import type { DesktopClient } from './use-merged-desktop-catalogs'

type KnownHostClient = {
  hostId: string
  client: RpcClient
  state: ConnectionState
}

export function buildProjectsHomeDesktopRoster(
  hostCatalog: readonly HostCatalogEntry[],
  knownClients: readonly KnownHostClient[],
  autoConnectHostIds: readonly string[],
  acquireClient: (
    host: HostProfile,
    signal?: AbortSignal,
    onClientOwned?: (client: RpcClient) => void
  ) => Promise<TransientHostClientLease | null>
): DesktopClient[] {
  const clients = new Map(knownClients.map((entry) => [entry.hostId, entry] as const))
  return hostCatalog.map((host) => {
    const entry = clients.get(host.id)
    return {
      hostId: host.id,
      hostName: host.name,
      client: entry?.client ?? null,
      availableOnDemand: !entry && host.profile != null,
      state:
        host.credentialStatus === 'missing'
          ? 'auth-failed'
          : host.credentialStatus === 'temporarily-unavailable'
            ? 'disconnected'
            : resolveHomeHostConnectionState(host.id, entry?.state, autoConnectHostIds),
      ...(host.profile ? { profile: host.profile, acquireClient } : {})
    }
  })
}
