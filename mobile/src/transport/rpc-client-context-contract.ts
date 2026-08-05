import type { RpcClient } from './rpc-client'
import type { MobileConnectionPath } from './stable-logical-rpc-client'
import type { ConnectionState, HostProfile } from './types'
import type { HostProfileEdit } from './host-endpoint-edit'

export type RpcClientContextValue = {
  acquire: (hostId: string, host?: HostProfile) => RpcClient | null
  release: (hostId: string) => void
  forceReconnect: (hostId: string, host?: HostProfile) => Promise<void>
  forceReconnectAfterEdit: (
    hostId: string,
    fallbackHost: HostProfile,
    updates: HostProfileEdit
  ) => Promise<void>
  closeHost: (hostId: string) => void
  getState: (hostId: string) => ConnectionState
  getKnownState: (hostId: string) => ConnectionState | null
  getReconnectAttempt: (hostId: string) => number
  getLastConnectedAt: (hostId: string) => number | null
  getRpcUnresponsiveSince: (hostId: string) => number | null
  getActivePath: (hostId: string) => MobileConnectionPath
  subscribeHostState: (hostId: string, listener: (state: ConnectionState) => void) => () => void
  getAllClients: () => { hostId: string; client: RpcClient }[]
  subscribeAllHosts: (listener: () => void) => () => void
  primeHosts: (hosts: HostProfile[], sourceRevision: number) => void
}
