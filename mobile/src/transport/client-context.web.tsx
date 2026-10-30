// The shell owns pairing and transport; carry its existing client through the page bridge.
import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react'
import type { BridgeRpcClient } from '../mobile-web-shell/bridge/bridge-rpc-client'
import { BRIDGE_PAGE_CLIENT_ID } from '../mobile-web-shell/bridge/bridge-page-client-identity'
import type { ConnectionState, HostProfile } from './types'
import type { RpcClientContextValue } from './rpc-client-context-contract'

const Ctx = createContext<RpcClientContextValue | null>(null)
// Keep page session routing separate from the shared screen client contract.
const PageClientCtx = createContext<BridgeRpcClient | null>(null)

// Inject the entry’s initialized client; building another would compete for the channel’s one onmessage slot.
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
      // Every route in this document reaches the one host the shell opened.
      acquire: (hostId: string) => {
        acquiredRef.current.add(hostId)
        return client
      },
      // The shell owns connection lifecycle; the page cannot reopen a client after goodbye.
      release: () => {},
      releaseAndCloseIfUnused: () => {},
      closeIfUnused: () => {},
      // Null hides reconnect controls the page cannot fulfill; wait for shell recovery.
      forceReconnect: null,
      refreshHostClient: () => {},
      forgetHostClient: () => {},
      disconnectHostClient: () => {},
      getState: () => client.getState(),
      // Nothing mounts before `init`, so the page's state is never the unknown this answers null for.
      getKnownState: () => client.getState(),
      /** A placeholder the shell swaps for this device's real identity, never the credential. */
      getClientId: () => BRIDGE_PAGE_CLIENT_ID,
      getReconnectAttempt: () => client.getReconnectAttempt(),
      getLastConnectedAt: () => client.getLastConnectedAt(),
      // Use relay until init carries the negotiated native path; the page has no independent transport.
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

// Shared/native mounts may have no page provider; return null so optional seams degrade without crashing.
export function usePageBridgeClientIfPresent(): BridgeRpcClient | null {
  return useContext(PageClientCtx) ?? null
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
