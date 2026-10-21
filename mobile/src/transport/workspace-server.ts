import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { MobileRelayHost } from '../../../src/shared/mobile-relay-hosts-contract'
import { useRelayHosts } from '../worktree/relay-hosts-feed'
import {
  scopeRpcClientToExecutionHost,
  workspaceRouteExecutionHost
} from './execution-host-scoped-rpc-client'
import { useHostStatusGates, type HostStatusGates } from './host-status-gates'
import type { RpcClient } from './rpc-client'
import type { ConnectionState } from './types'

/**
 * Where a workspace runs, as seen through the paired desktop. Whether a server is reachable stays
 * the desktop's answer; what it supports is the server's own status, read through the desktop.
 * `server` is null for the desktop's own workspaces (local, SSH, folder).
 */
export function useWorkspaceServer(args: {
  client: RpcClient | null
  connState: ConnectionState
  desktopCapabilities: readonly string[]
  executionHost: ExecutionHostId | undefined
}): {
  routeHost: ExecutionHostId | undefined | null
  server: { client: RpcClient | null; state: ConnectionState; gates: HostStatusGates } | null
} {
  const { client, connState, desktopCapabilities, executionHost } = args
  const routeHost = workspaceRouteExecutionHost(client, desktopCapabilities, executionHost)
  const serverClient = client && routeHost ? scopeRpcClientToExecutionHost(client, routeHost) : null
  // The same feed the host list reads, so the desktop is not polled twice.
  const hosts = useRelayHosts(routeHost ? client : null)
  const state =
    connState === 'connected' && routeHost && hosts
      ? serverConnState(hosts.find((entry) => entry.hostId === routeHost))
      : connState
  // No hostId: the desktop's recorded version and descriptor must not take the server's. The
  // server's own state, so its restart under a connected desktop re-reads what it supports.
  const gates = useHostStatusGates({ hostId: undefined, client: serverClient, connState: state })
  return {
    routeHost,
    server: routeHost === undefined ? null : { client: serverClient, state, gates }
  }
}

/**
 * Whether the desktop can relay calls to the server now. A server it is reaching or has just
 * reached (status not answered yet) reads `connecting`, matching the desktop's reconnecting banner;
 * one too old to relay to, or no longer listed, is unreachable.
 */
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
