// Web sibling: RN Web has no pairing keychain and no websocket transport of its own, so the page
// gets a placeholder client until C0.4 lands BridgeRpcClient over the shell bridge.
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { RpcClient } from './rpc-client'
import type { ConnectionState, HostProfile } from './types'
import type { RpcClientContextValue } from './rpc-client-context-contract'

export {
  useDisconnectHostClient,
  useForceReconnect,
  useForgetHostClient,
  useHostClient,
  usePrimeHosts,
  useRefreshHostClient
} from './host-client-hooks'

/** Named so a page-side failure is never mistaken for a host RpcFailure. */
export class BridgeTransportUnavailableError extends Error {
  constructor(what: string) {
    super(`bridge transport unavailable: ${what}`)
    this.name = 'BridgeTransportUnavailableError'
  }
}

function createPlaceholderClient(): RpcClient {
  return {
    sendRequest: (method) => Promise.reject(new BridgeTransportUnavailableError(method)),
    // No synthetic frame: stream readers are checked, and inventing a shape they must parse
    // would fail differently from the real bridge. Screens stay in their loading state.
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'disconnected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    getLastInboundAt: () => null,
    getGeneration: () => 0,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
}

const Ctx = createContext<RpcClientContextValue | null>(null)

export function RpcClientProvider({ children }: { children: ReactNode }) {
  const value = useMemo<RpcClientContextValue>(() => {
    const client = createPlaceholderClient()
    const disconnected: ConnectionState = 'disconnected'
    return {
      acquire: () => client,
      release: () => {},
      releaseAndCloseIfUnused: () => {},
      closeIfUnused: () => {},
      forceReconnect: () => Promise.resolve(),
      refreshHostClient: () => {},
      forgetHostClient: () => {},
      disconnectHostClient: () => {},
      getState: () => disconnected,
      getKnownState: () => disconnected,
      getClientId: () => null,
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => null,
      // The page reaches its host through the shell bridge, which rides whatever path the RN
      // client already negotiated. 'relay' is the honest default until init carries the real one.
      getActivePath: () => 'relay',
      getPendingPath: () => null,
      isPairingRejected: () => false,
      isHostSignedOut: () => false,
      subscribeHostState: () => () => {},
      getAllClients: () => [],
      subscribeAllHosts: () => () => {},
      primeHosts: (_hosts: HostProfile[]) => {}
    }
  }, [])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useRpcClientContext(): RpcClientContextValue {
  const value = useContext(Ctx)
  if (!value) {
    throw new Error('useRpcClientContext must be used within RpcClientProvider')
  }
  return value
}
