import { createContext, useContext } from 'react'
import { useHostClient } from './host-client-hooks'
import type { RpcClient } from './rpc-client'
import type { ConnectionState } from './types'

// Provided by `WorkspaceRoute` for a server's workspace (client null until reachable); absent otherwise.
export const WorkspaceServerContext = createContext<
  { client: RpcClient | null; state: ConnectionState } | undefined
>(undefined)

/** `useHostClient` for a workspace screen: its calls run where the workspace does. */
export function useWorkspaceClient(hostId: string | undefined): ReturnType<typeof useHostClient> {
  const host = useHostClient(hostId)
  const server = useContext(WorkspaceServerContext)
  return server === undefined ? host : { ...host, client: server.client, state: server.state }
}
