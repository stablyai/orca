import { createContext, useContext } from 'react'
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

/** False only when a paired desktop relays this route to a server and lacks the capability itself. */
export function useRouteRelaysCapability(capability: string): boolean {
  return useContext(WorkspaceServerContext)?.desktopCapabilities.includes(capability) ?? true
}
