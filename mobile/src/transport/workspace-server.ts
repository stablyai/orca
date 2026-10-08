import type { ExecutionHostId } from '../../../src/shared/execution-host'
import {
  composesDesktopTabs,
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
  server: { client: RpcClient | null; gates: HostStatusGates } | null
} {
  const { client, connState, desktopCapabilities, executionHost } = args
  const routeHost = workspaceRouteExecutionHost(client, desktopCapabilities, executionHost)
  const serverClient =
    client && routeHost
      ? scopeRpcClientToExecutionHost(client, routeHost, composesDesktopTabs(desktopCapabilities))
      : null
  // No hostId: the desktop's recorded version and descriptor must not take the server's.
  const gates = useHostStatusGates({ hostId: undefined, client: serverClient, connState })
  return { routeHost, server: routeHost === undefined ? null : { client: serverClient, gates } }
}
