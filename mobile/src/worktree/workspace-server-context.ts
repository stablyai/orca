import { createContext, useContext } from 'react'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../transport/connection/connection-state'
import type { ServerHostDesktopReach } from './server-workspaces'
import type { HostStatusGates } from '../transport/connection/host-status-gates'

// WorkspaceRoute supplies server context; null means unreachable, absent means desktop routing.
export type WorkspaceServer = {
  client: RpcClient | null
  state: ConnectionState
  desktopCapabilities: readonly string[]
  /** The paired desktop's own gates, which a server's scope replaces in context; null before they load. */
  desktopGates?: HostStatusGates | null
  name?: string | null
  desktopReach?: ServerHostDesktopReach
}

export const WorkspaceServerContext = createContext<WorkspaceServer | undefined>(undefined)

/** False only when a paired desktop relays this route to a server and lacks the capability itself. */
export function useRouteRelaysCapability(capability: string): boolean {
  return useContext(WorkspaceServerContext)?.desktopCapabilities.includes(capability) ?? true
}
