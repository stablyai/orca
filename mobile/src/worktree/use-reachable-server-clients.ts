import { useMemo } from 'react'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { MobileRelayHost } from '../../../src/shared/mobile-relay-hosts-contract'
import {
  reachableServerClients,
  relaysToServers
} from '../transport/execution-host-scoped-rpc-client'
import type { RpcClient } from '../transport/rpc-client'
import { useRelayHosts } from './relay-hosts-feed'

// Key clients by the ready-server set so health/label changes cannot trigger repo reloads.
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
    [client, hostCapabilities, readyKey]
  )
  return { servers, serverClients }
}
