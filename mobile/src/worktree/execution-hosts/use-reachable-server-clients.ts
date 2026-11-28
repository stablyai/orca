import { useMemo } from 'react'
import type { ExecutionHostId } from '../../../../src/shared/execution-host/execution-host'
import type { MobileRelayHost } from '../../../../src/shared/remote-runtime/relay/mobile-relay-hosts-contract'
import { reachableServerClients, relaysToServers } from './execution-host-scoped-rpc-client'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { useRelayHosts } from './relay-hosts-feed'
import { useKeptByKey } from '../../hooks/use-kept-by-key'

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
  const servers = useRelayHosts(active && relays ? client : null, hostCapabilities)
  const readyKey = (servers ?? [])
    .filter((host) => host.relay === 'ready')
    .map((host) => host.hostId)
    .sort()
    .join('\n')
  const keptServers = useKeptByKey(readyKey, servers ?? [])
  const serverClients = useMemo(
    () => reachableServerClients(client, hostCapabilities, keptServers),
    [client, hostCapabilities, keptServers]
  )
  return { servers, serverClients }
}
