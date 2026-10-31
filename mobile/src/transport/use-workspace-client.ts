import { createContext, useContext } from 'react'
import { useHostProtocolGates } from '../components/host-protocol-gates-context'
import { useHostClient } from './host-client-hooks'
import type { RpcClient } from './rpc-client'
import type { ConnectionState } from './types'

// WorkspaceRoute supplies server context; null means unreachable, absent means desktop routing.
export const WorkspaceServerContext = createContext<
  | {
      client: RpcClient | null
      state: ConnectionState
      desktopCapabilities: readonly string[]
      name?: string | null
    }
  | undefined
>(undefined)

/** The route's host has the capability; a relayed route also needs the paired desktop to forward it. */
export function useRouteCapability(capability: string): boolean {
  const { hostCapabilities } = useHostProtocolGates()
  const server = useContext(WorkspaceServerContext)
  return (
    hostCapabilities.includes(capability) &&
    (server?.desktopCapabilities.includes(capability) ?? true)
  )
}

export function useWorkspaceClient(hostId: string | undefined): ReturnType<typeof useHostClient> {
  const host = useHostClient(hostId)
  const server = useContext(WorkspaceServerContext)
  return server === undefined ? host : { ...host, client: server.client, state: server.state }
}
