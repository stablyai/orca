import { useContext } from 'react'
import { useHostClient } from '../../transport/connection/host-client-hooks'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../../transport/connection/connection-state'
import { WorkspaceServerContext, type WorkspaceServer } from './workspace-server-context'

// Kept apart so a view that only reads capabilities doesn't load the connection stack.
export { useRouteCapability } from './use-route-capability'

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
