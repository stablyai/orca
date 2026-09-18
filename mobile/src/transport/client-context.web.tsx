// Web sibling: RN Web has no pairing keychain and no websocket transport of its own, so the page's
// client is the shell bridge. Nothing here dials, retries or pairs — the native client on the other
// side of the bridge already did, and this provider only carries what it holds across the boundary.
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import {
  createBridgeRpcClient,
  type BridgeRpcClient,
  type BridgeRpcClientDiagnostic
} from '../mobile-web-shell/bridge/bridge-rpc-client'
import {
  createOrcaBridgePageTransport,
  readOrcaBridgePageChannel
} from '../mobile-web-shell/bridge/orca-bridge-page-channel'
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

/**
 * For a page opened outside the shell: a browser, or a WebView mounted with the bridge off.
 *
 * It answers every member and reaches nothing, which is what lets the route tree mount and paint
 * its empty states instead of crashing on a client that is not there.
 */
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

/** One line per kind for the life of one page: a page that is failing frames fails all of them. */
function createPageDiagnosticReporter(): (diagnostic: BridgeRpcClientDiagnostic) => void {
  const reported = new Set<BridgeRpcClientDiagnostic['kind']>()
  return (diagnostic) => {
    if (reported.has(diagnostic.kind)) {
      return
    }
    reported.add(diagnostic.kind)
    console.warn('[page-bridge]', diagnostic.kind, diagnostic)
  }
}

const Ctx = createContext<RpcClientContextValue | null>(null)

export function RpcClientProvider({ children }: { children: ReactNode }) {
  // Held in a ref as well as in state: the context value is built once, because `useHostClient`
  // re-acquires whenever the value's identity changes.
  const clientRef = useRef<RpcClient | null>(null)
  const acquiredRef = useRef<Set<string>>(new Set())
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const channel = readOrcaBridgePageChannel()
    if (channel === null) {
      // Nothing to wait for, so the tree mounts against the placeholder rather than never.
      clientRef.current = createPlaceholderClient()
      setReady(true)
      return
    }
    const client: BridgeRpcClient = createBridgeRpcClient({
      ...createOrcaBridgePageTransport(channel),
      onDiagnostic: createPageDiagnosticReporter()
    })
    // Nothing mounts before `init`: every member of this client throws until the shell answers,
    // and a screen that rendered first would record its first frame against a session-less client.
    const release = client.onReady(() => {
      clientRef.current = client
      setReady(true)
    })
    return () => {
      release()
      clientRef.current = null
      setReady(false)
      client.close()
    }
  }, [])

  const value = useMemo<RpcClientContextValue>(() => {
    const state = (): ConnectionState => clientRef.current?.getState() ?? 'connecting'
    return {
      // One client for one page: the shell opened this document for one host, so whichever host
      // the route names is the host on the other side of the bridge.
      acquire: (hostId: string) => {
        acquiredRef.current.add(hostId)
        return clientRef.current
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
      getState: state,
      getKnownState: () => (clientRef.current === null ? null : state()),
      getClientId: () => null,
      getReconnectAttempt: () => clientRef.current?.getReconnectAttempt() ?? 0,
      getLastConnectedAt: () => clientRef.current?.getLastConnectedAt() ?? null,
      // The page reaches its host through the shell bridge, which rides whatever path the RN
      // client already negotiated. 'relay' is the honest default until init carries the real one.
      getActivePath: () => 'relay',
      getPendingPath: () => null,
      // Both are pairing verdicts, and pairing happened natively before this document existed.
      isPairingRejected: () => false,
      isHostSignedOut: () => false,
      subscribeHostState: (_hostId: string, listener: (next: ConnectionState) => void) =>
        clientRef.current?.onStateChange(listener) ?? (() => {}),
      getAllClients: () => {
        const client = clientRef.current
        return client === null ? [] : [...acquiredRef.current].map((hostId) => ({ hostId, client }))
      },
      subscribeAllHosts: (listener: () => void) =>
        clientRef.current?.onStateChange(() => {
          listener()
        }) ?? (() => {}),
      primeHosts: (_hosts: HostProfile[]) => {}
    }
  }, [])

  return <Ctx.Provider value={value}>{ready ? children : null}</Ctx.Provider>
}

export function useRpcClientContext(): RpcClientContextValue {
  const value = useContext(Ctx)
  if (!value) {
    throw new Error('useRpcClientContext must be used within RpcClientProvider')
  }
  return value
}
