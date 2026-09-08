import { createContext, useContext, type ReactNode } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcClientContextValue } from '../transport/rpc-client-context-contract'
import type { MobileConnectionPath } from '../transport/stable-logical-rpc-client'
import type { ConnectionState, HostProfile } from '../transport/types'

export type { RpcClientContextValue } from '../transport/rpc-client-context-contract'

const noop = () => {}
const value: RpcClientContextValue = {
  acquire: () => null,
  release: noop,
  releaseAndCloseIfUnused: noop,
  closeIfUnused: noop,
  async forceReconnect() {},
  refreshHostClient: noop,
  forgetHostClient: noop,
  disconnectHostClient: noop,
  getState: () => 'disconnected',
  getKnownState: () => null,
  getClientId: () => null,
  getReconnectAttempt: () => 0,
  getLastConnectedAt: () => null,
  getActivePath: () => 'lan',
  getPendingPath: () => null,
  isPairingRejected: () => false,
  isHostSignedOut: () => false,
  subscribeHostState: () => noop,
  getAllClients: () => [],
  subscribeAllHosts: () => noop,
  primeHosts: noop
}
const Ctx = createContext<RpcClientContextValue | null>(null)
const disconnectedClient = { client: null, clientId: null, state: 'disconnected' } as const

export function RpcClientProvider({ children }: { children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useRpcClientContext(): RpcClientContextValue {
  const context = useContext(Ctx)
  if (!context) {
    throw new Error('Hosted client context provider unavailable')
  }
  return context
}

export function useHostClient(_hostId: string | undefined): {
  client: RpcClient | null
  clientId: string | null
  state: ConnectionState
} {
  useRpcClientContext()
  return disconnectedClient
}

export function useAllHostClients(_hostIds: string[]): {
  hostId: string
  client: RpcClient
  state: ConnectionState
  path: MobileConnectionPath
}[] {
  useRpcClientContext()
  return []
}

export function useCloseHost(): (hostId: string) => void {
  return useRpcClientContext().disconnectHostClient
}

export function useForceReconnect(): (hostId: string) => Promise<void> {
  return useRpcClientContext().forceReconnect
}

export function usePrimeHosts(): (hosts: HostProfile[]) => void {
  return useRpcClientContext().primeHosts
}
