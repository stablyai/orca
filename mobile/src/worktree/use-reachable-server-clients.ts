import { useMemo } from 'react'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { MobileRelayHost } from '../../../src/shared/mobile-relay-hosts-contract'
import {
  reachableServerClients,
  relaysToServers
} from '../transport/execution-host-scoped-rpc-client'
import type { RpcClient } from '../transport/rpc-client'
import { useRelayHosts } from './relay-hosts-feed'

/**
 * The desktop's servers from the shared feed while `active`, and a scoped client for each one this
 * phone can reach now. The clients change only when the set of ready servers does, so a health or
 * label change re-lists nothing.
 */
export function useReachableServerClients(
  client: RpcClient | null,
  hostCapabilities: readonly string[],
  active = true
): {
  servers: readonly MobileRelayHost[] | null
  serverClients: ReadonlyMap<ExecutionHostId, RpcClient>
} {
  const relays = client !== null && relaysToServers(client, hostCapabilities)
  const servers = useRelayHosts(active && relays ? client : null)
  const readyKey = (servers ?? [])
    .filter((host) => host.relay === 'ready')
    .map((host) => host.hostId)
    .sort()
    .join('\n')
  const serverClients = useMemo(
    () => reachableServerClients(client, hostCapabilities, servers ?? []),
    // Keyed on the ready set rather than the feed's rows: see above.
    [client, hostCapabilities, readyKey]
  )
  return { servers, serverClients }
}
