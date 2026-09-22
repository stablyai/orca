// Web sibling: RN Web has no pairing keychain and no websocket transport of its own, so the page's
// client is the shell bridge. Nothing here dials, retries or pairs — the native client on the other
// side of the bridge already did, and this provider only carries what it holds across the boundary.
import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react'
import type { BridgeRpcClient } from '../mobile-web-shell/bridge/bridge-rpc-client'
import {
  BRIDGE_PAGE_CLIENT_ID,
  BRIDGE_PAGE_CLIENT_IDENTITY_ACCEPT
} from '../mobile-web-shell/bridge/bridge-page-client-identity'
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

const Ctx = createContext<RpcClientContextValue | null>(null)
/** The page's own client, which is more than an `RpcClient`: the route seam reads the session off
 *  it to decide which screens are this document's. Separate from `Ctx` so the shared contract above
 *  stays the one every screen sees, page or native. */
const PageClientCtx = createContext<BridgeRpcClient | null>(null)

/**
 * The client is injected rather than built here: the entry owns it, because it has to wait for
 * `init` before it renders anything at all, and a provider that built its own would be a second
 * client reading the one `onmessage` slot the page's channel has.
 */
export function RpcClientProvider({
  client,
  children
}: {
  client: BridgeRpcClient
  children: ReactNode
}) {
  const acquiredRef = useRef<Set<string>>(new Set())

  const value = useMemo<RpcClientContextValue>(() => {
    return {
      // One client for one page: the shell opened this document for one host, so whichever host
      // the route names is the host on the other side of the bridge.
      acquire: (hostId: string) => {
        acquiredRef.current.add(hostId)
        return client
      },
      // The shell owns the connection, and a page client cannot be reopened once it says goodbye.
      // Every member that would close, drop or re-dial one is inert here for that reason.
      release: () => {},
      releaseAndCloseIfUnused: () => {},
      closeIfUnused: () => {},
      forceReconnect: () => Promise.resolve(),
      refreshHostClient: () => {},
      forgetHostClient: () => {},
      disconnectHostClient: () => {},
      getState: () => client.getState(),
      // Nothing mounts before `init`, so the page's state is never the unknown this answers null for.
      getKnownState: () => client.getState(),
      /**
       * A placeholder the shell swaps for this device's real identity, never the credential itself.
       *
       * Only when the shell said it performs the swap; a shell that did not leaves this null, which
       * is no terminal and no live input, because the session route refuses to subscribe or send
       * without one — but a placeholder the host read itself would be refused as a spoof.
       */
      getClientId: () =>
        client.getShellSession()?.accepts.includes(BRIDGE_PAGE_CLIENT_IDENTITY_ACCEPT) === true
          ? BRIDGE_PAGE_CLIENT_ID
          : null,
      getReconnectAttempt: () => client.getReconnectAttempt(),
      getLastConnectedAt: () => client.getLastConnectedAt(),
      // The page reaches its host through the shell bridge, which rides whatever path the RN
      // client already negotiated. 'relay' is the honest default until init carries the real one.
      getActivePath: () => 'relay',
      getPendingPath: () => null,
      // Both are pairing verdicts, and pairing happened natively before this document existed.
      isPairingRejected: () => false,
      getRelayHostReachability: () => 'connecting',
      subscribeHostState: (_hostId: string, listener: (next: ConnectionState) => void) =>
        client.onStateChange(listener),
      getAllClients: () => [...acquiredRef.current].map((hostId) => ({ hostId, client })),
      subscribeAllHosts: (listener: () => void) =>
        client.onStateChange(() => {
          listener()
        }),
      primeHosts: (_hosts: HostProfile[]) => {}
    }
  }, [client])

  return (
    <PageClientCtx.Provider value={client}>
      <Ctx.Provider value={value}>{children}</Ctx.Provider>
    </PageClientCtx.Provider>
  )
}

/** For the page-only seams that need the bridge itself rather than the client contract over it. */
export function usePageBridgeClient(): BridgeRpcClient {
  const client = useContext(PageClientCtx)
  if (!client) {
    throw new Error('usePageBridgeClient must be used within RpcClientProvider')
  }
  return client
}

export function useRpcClientContext(): RpcClientContextValue {
  const value = useContext(Ctx)
  if (!value) {
    throw new Error('useRpcClientContext must be used within RpcClientProvider')
  }
  return value
}
