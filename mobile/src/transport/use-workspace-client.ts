import { createContext, useContext } from 'react'
import { useHostClient } from './client-context'
import type { RpcClient } from './rpc-client'

// Provided by `WorkspaceRoute` for a server's workspace (null until reachable); absent otherwise.
export const WorkspaceServerClientContext = createContext<RpcClient | null | undefined>(undefined)

/** `useHostClient` for a workspace screen: its calls run where the workspace does. */
export function useWorkspaceClient(hostId: string | undefined): ReturnType<typeof useHostClient> {
  const host = useHostClient(hostId)
  const serverClient = useContext(WorkspaceServerClientContext)
  return serverClient === undefined ? host : { ...host, client: serverClient }
}
