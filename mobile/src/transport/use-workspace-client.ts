import { createContext, useContext } from 'react'
import { useHostClient } from './host-client-hooks'
import type { RpcClient } from './rpc-client'
import type { ConnectionState } from './types'

// WorkspaceRoute supplies server context; null means unreachable, absent means desktop routing.
export const WorkspaceServerContext = createContext<
  { client: RpcClient | null; state: ConnectionState } | undefined
>(undefined)

export function useWorkspaceClient(hostId: string | undefined): ReturnType<typeof useHostClient> {
  const host = useHostClient(hostId)
  const server = useContext(WorkspaceServerContext)
  return server === undefined ? host : { ...host, client: server.client, state: server.state }
}
