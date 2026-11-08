import { useContext } from 'react'
import { useHostProtocolGates } from '../components/host-protocol-gates-context'
import { useHostClient } from '../transport/connection/host-client-hooks'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../transport/connection/connection-state'
import {
  useRouteRelaysCapability,
  WorkspaceServerContext,
  type WorkspaceServer
} from './workspace-server-context'

/** The route's host has the capability; a relayed route also needs the paired desktop to forward it. */
export function useRouteCapability(capability: string): boolean {
  const { hostCapabilities } = useHostProtocolGates()
  const relayed = useRouteRelaysCapability(capability)
  return hostCapabilities.includes(capability) && relayed
}

export function useWorkspaceClient(hostId: string | undefined): ReturnType<typeof useHostClient> & {
  /** The route's own paired host, which stays the phone's peer when a server executes the workspace. */
  pairedHostClient: RpcClient | null
  pairedHostState: ConnectionState
  /** The server that executes this workspace; undefined on desktop routing. */
  workspaceServer: WorkspaceServer | undefined
} {
  const host = useHostClient(hostId)
  const server = useContext(WorkspaceServerContext)
  const paired = {
    ...host,
    pairedHostClient: host.client,
    pairedHostState: host.state,
    workspaceServer: server
  }
  return server === undefined ? paired : { ...paired, client: server.client, state: server.state }
}
