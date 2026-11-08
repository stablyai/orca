import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { MobileRelayHost } from '../../../src/shared/remote-runtime/relay/mobile-relay-hosts-contract'
import { useRelayHosts } from './relay-hosts-feed'
import { serverHostDesktopReach, type ServerHostDesktopReach } from './server-workspaces'
import {
  scopeRpcClientToExecutionHost,
  workspaceRouteExecutionHost
} from './execution-host-scoped-rpc-client'
import { useHostStatusGates, type HostStatusGates } from '../transport/connection/host-status-gates'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../transport/connection/connection-state'

// Read reachability from the paired desktop and capabilities from the server; null server means local/SSH/folder workspaces.
export function useWorkspaceServer(args: {
  client: RpcClient | null
  connState: ConnectionState
  desktopCapabilities: readonly string[]
  executionHost: ExecutionHostId | undefined
}): {
  routeHost: ExecutionHostId | undefined | null
  server: {
    client: RpcClient | null
    state: ConnectionState
    name: string | null
    desktopReach: ServerHostDesktopReach | undefined
    gates: HostStatusGates
    desktopCapabilities: readonly string[]
  } | null
} {
  const { client, connState, desktopCapabilities, executionHost } = args
  const routeHost = workspaceRouteExecutionHost(client, desktopCapabilities, executionHost)
  const serverClient = client && routeHost ? scopeRpcClientToExecutionHost(client, routeHost) : null
  // The same feed the host list reads, so the desktop is not polled twice.
  const hosts = useRelayHosts(routeHost ? client : null)
  const selectedHost = hosts?.find((entry) => entry.hostId === routeHost)
  const state =
    connState === 'connected' && routeHost && hosts ? serverConnState(selectedHost) : connState
  // Use the server’s own state and no desktop hostId so reconnect re-reads server gates without overwriting desktop identity.
  const gates = useHostStatusGates({ hostId: undefined, client: serverClient, connState: state })
  return {
    routeHost,
    server:
      routeHost === undefined
        ? null
        : {
            client: serverClient,
            state,
            name: selectedHost?.label ?? null,
            desktopReach: selectedHost ? serverHostDesktopReach(selectedHost) : undefined,
            gates,
            desktopCapabilities
          }
  }
}

// Treat a server awaiting status as connecting; an unlisted or incompatible server is unreachable.
function serverConnState(host: MobileRelayHost | undefined): ConnectionState {
  if (host?.relay === 'ready') {
    return 'connected'
  }
  if (
    host?.relay === 'unavailable' &&
    (host.health === 'connecting' || host.health === 'available')
  ) {
    return 'connecting'
  }
  return 'disconnected'
}
