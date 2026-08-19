// Single shared RpcClient per host, collapsing the old per-screen WebSocket connections.
// Design: docs/mobile-shared-client-per-host.md.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type { RpcClient } from './rpc-client'
import { subscribeConnectionRevivalTriggers } from './connection-revival-triggers'
import { HostClientOpenRegistry } from './host-client-open-registry'
import {
  HostClientAcquisitionRegistry,
  type HostClientAcquisition
} from './host-client-acquisition-registry'
import { HostOpenRetryScheduler } from './host-open-retry-scheduler'
import { openHostClientEntry, type HostClientStoreEntry } from './host-entry-opener'
import {
  createHostClientSelectors,
  listHostClients,
  notifyAllHostListeners,
  notifyHostStateListeners,
  primeHostProfiles,
  subscribeAllHostListener,
  subscribeHostStateListener,
  type CloseEntryOptions
} from './host-client-context-state'
import type { ConnectionState, HostProfile } from './types'
import type { RpcClientContextValue } from './rpc-client-context-contract'

type StoreEntry = HostClientStoreEntry
export type { HostClientAcquisition } from './host-client-acquisition-registry'
export type { RpcClientContextValue } from './rpc-client-context-contract'

const Ctx = createContext<RpcClientContextValue | null>(null)

export function RpcClientProvider({ children }: { children: ReactNode }) {
  // Why: entries in a ref so state changes don't re-render the whole tree; propagation goes through per-host listener Sets.
  const storeRef = useRef<Map<string, StoreEntry>>(new Map())
  const stateListenersRef = useRef<Map<string, Set<(state: ConnectionState) => void>>>(new Map())
  const allHostsListenersRef = useRef<Set<() => void>>(new Set())

  // Pending opens keyed by hostId so two acquire() callers in the same render don't race the host lookup.
  const pendingOpensRef = useRef(new HostClientOpenRegistry())
  const pendingAcquisitionsRef = useRef<Map<string, number>>(new Map())
  const acquisitionsRef = useRef(new HostClientAcquisitionRegistry())
  const manualDemandRef = useRef<Set<string>>(new Set())
  const retrySchedulerRef = useRef<HostOpenRetryScheduler | null>(null)

  // Why: cache of already-loaded HostProfiles so openEntry can skip a second loadHosts()/Keychain pass on cold start.
  const primedHostsRef = useRef<Map<string, HostProfile>>(new Map())

  const notifyHostState = (hostId: string, state: ConnectionState) =>
    notifyHostStateListeners(stateListenersRef.current, hostId, state)
  const notifyAllHosts = () => notifyAllHostListeners(allHostsListenersRef.current)

  const closeEntry = useCallback((hostId: string, options: CloseEntryOptions) => {
    const entry = storeRef.current.get(hostId)
    const acquisitionCount = acquisitionsRef.current.count(hostId)
    pendingOpensRef.current.cancel(hostId)
    retrySchedulerRef.current?.cancel(hostId)
    if (options.preserveAcquisitions && acquisitionCount > 0) {
      pendingAcquisitionsRef.current.set(hostId, acquisitionCount)
    } else {
      acquisitionsRef.current.clear(hostId)
      pendingAcquisitionsRef.current.delete(hostId)
    }
    if (!options.preserveAcquisitions) {
      manualDemandRef.current.delete(hostId)
    }
    if (options.forgetPrimedHost) {
      primedHostsRef.current.delete(hostId)
    }
    entry?.unsubState()
    entry?.unsubConnectionPath()
    storeRef.current.delete(hostId)
    entry?.client.close()
    notifyHostState(hostId, 'disconnected')
    notifyAllHosts()
  }, [])

  const openEntry = useCallback(
    (hostId: string, allowUnowned = false): Promise<StoreEntry | null> => {
      const retryScheduler = retrySchedulerRef.current
      if (!retryScheduler) {
        throw new Error('host retry scheduler not initialized')
      }
      return openHostClientEntry(
        {
          store: storeRef.current,
          pendingOpens: pendingOpensRef.current,
          pendingAcquisitions: pendingAcquisitionsRef.current,
          primedHosts: primedHostsRef.current,
          retryScheduler,
          notifyHostState,
          notifyAllHosts
        },
        hostId,
        allowUnowned
      ).then((entry) => {
        if (entry) {
          manualDemandRef.current.delete(hostId)
        }
        return entry
      })
    },
    []
  )

  if (!retrySchedulerRef.current) {
    retrySchedulerRef.current = new HostOpenRetryScheduler({
      canRetry: (hostId, generation) =>
        pendingOpensRef.current.isGenerationCurrent(hostId, generation) &&
        ((pendingAcquisitionsRef.current.get(hostId) ?? 0) > 0 ||
          manualDemandRef.current.has(hostId)) &&
        !storeRef.current.has(hostId) &&
        pendingOpensRef.current.getActivePromise(hostId) === null,
      open: (hostId) => void openEntry(hostId, manualDemandRef.current.has(hostId))
    })
  }

  // Synchronous get-or-open: returns an existing client immediately, else kicks off an async open and returns null this tick.
  const acquire = useCallback(
    (hostId: string, acquisition: HostClientAcquisition, host?: HostProfile): RpcClient | null => {
      if (host) {
        primedHostsRef.current.set(hostId, host)
      }
      const acquisitionCount = acquisitionsRef.current.acquire(hostId, acquisition)
      const existing = storeRef.current.get(hostId)
      if (existing) {
        existing.refCount = acquisitionCount
        return existing.client
      }
      pendingAcquisitionsRef.current.set(hostId, acquisitionCount)
      // Trigger async open; returns null this tick — consumers re-call acquire() from an effect that re-runs on state changes.
      void openEntry(hostId)
      return null
    },
    [openEntry]
  )

  const primeHosts = useCallback(
    (hosts: HostProfile[]) => primeHostProfiles(primedHostsRef.current, hosts),
    []
  )

  const refreshHostClient = useCallback(
    (hostId: string) => {
      closeEntry(hostId, { forgetPrimedHost: true, preserveAcquisitions: true })
      if ((pendingAcquisitionsRef.current.get(hostId) ?? 0) > 0) {
        void openEntry(hostId)
      }
    },
    [closeEntry, openEntry]
  )

  const forgetHostClient = useCallback(
    (hostId: string) => {
      closeEntry(hostId, { forgetPrimedHost: true, preserveAcquisitions: false })
    },
    [closeEntry]
  )

  const disconnectHostClient = useCallback(
    (hostId: string) => {
      closeEntry(hostId, { forgetPrimedHost: false, preserveAcquisitions: false })
    },
    [closeEntry]
  )

  // Why: no idle-close on refcount→0 — transient nav gaps flashed false 'disconnected', so keep sockets alive while foregrounded.
  const release = useCallback((hostId: string, acquisition: HostClientAcquisition) => {
    const acquisitionCount = acquisitionsRef.current.release(hostId, acquisition)
    if (acquisitionCount === null) {
      return
    }
    const entry = storeRef.current.get(hostId)
    if (entry) {
      entry.refCount = acquisitionCount
      return
    }
    if (acquisitionCount > 0) {
      pendingAcquisitionsRef.current.set(hostId, acquisitionCount)
    } else {
      pendingAcquisitionsRef.current.delete(hostId)
      if (!manualDemandRef.current.has(hostId)) {
        pendingOpensRef.current.cancel(hostId)
        retrySchedulerRef.current?.cancel(hostId)
      }
    }
  }, [])

  const releaseAndCloseIfUnused = useCallback(
    (hostId: string, acquisition: HostClientAcquisition) => {
      const acquisitionCount = acquisitionsRef.current.release(hostId, acquisition)
      if (acquisitionCount === null) {
        if (acquisitionsRef.current.count(hostId) === 0) {
          closeEntry(hostId, { forgetPrimedHost: false, preserveAcquisitions: false })
        }
        return
      }
      const entry = storeRef.current.get(hostId)
      if (entry) {
        entry.refCount = acquisitionCount
        if (entry.refCount === 0) {
          closeEntry(hostId, { forgetPrimedHost: false, preserveAcquisitions: false })
        }
        return
      }
      if (acquisitionCount > 0) {
        pendingAcquisitionsRef.current.set(hostId, acquisitionCount)
      } else {
        closeEntry(hostId, { forgetPrimedHost: false, preserveAcquisitions: false })
      }
    },
    [closeEntry]
  )

  const closeIfUnused = useCallback(
    (hostId: string) => {
      const entry = storeRef.current.get(hostId)
      const acquisitionCount = acquisitionsRef.current.count(hostId)
      const hasPendingOpen = pendingOpensRef.current.getActivePromise(hostId) !== null
      if (!entry && acquisitionCount === 0 && !hasPendingOpen) {
        return
      }
      if (acquisitionCount === 0) {
        closeEntry(hostId, { forgetPrimedHost: false, preserveAcquisitions: false })
      }
    },
    [closeEntry]
  )

  const forceReconnect = useCallback(
    async (hostId: string) => {
      const entry = storeRef.current.get(hostId)
      // Why: ownership survives explicit close/re-pair while observers never become synthetic owners.
      const savedRefCount = acquisitionsRef.current.count(hostId)
      manualDemandRef.current.add(hostId)
      if (entry) {
        entry.unsubState()
        entry.unsubConnectionPath()
        entry.client.close()
        storeRef.current.delete(hostId)
      }
      pendingOpensRef.current.cancel(hostId)
      retrySchedulerRef.current?.cancel(hostId)
      if (savedRefCount > 0) {
        pendingAcquisitionsRef.current.set(
          hostId,
          Math.max(savedRefCount, pendingAcquisitionsRef.current.get(hostId) ?? 0)
        )
      }
      // Why: Retry must read amber for the whole reopen, not grey-then-amber.
      notifyHostState(hostId, 'connecting')
      await openEntry(hostId, true)
    },
    [openEntry]
  )

  const selectors = useMemo(
    () => createHostClientSelectors(storeRef.current, pendingOpensRef.current),
    []
  )

  const subscribeHostState = useCallback(
    (hostId: string, listener: (state: ConnectionState) => void) =>
      subscribeHostStateListener(stateListenersRef.current, hostId, listener),
    []
  )

  const getAllClients = useCallback(() => listHostClients(storeRef.current), [])

  const subscribeAllHosts = useCallback(
    (listener: () => void) => subscribeAllHostListener(allHostsListenersRef.current, listener),
    []
  )

  // Close all clients on provider unmount. Empty deps: [closeEntry] would let Fast Refresh tear down all live sockets.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const store = storeRef.current
    return () => {
      pendingOpensRef.current.cancelAll()
      retrySchedulerRef.current?.cancelAll()
      acquisitionsRef.current.clearAll()
      manualDemandRef.current.clear()
      pendingAcquisitionsRef.current.clear()
      for (const [hostId] of store) {
        closeEntry(hostId, { forgetPrimedHost: true, preserveAcquisitions: false })
      }
    }
  }, [])

  // Why: nudge live clients when the OS signals the link may be back so sessions recover without a restart (issue #5049).
  useEffect(() => {
    return subscribeConnectionRevivalTriggers((reason) => {
      for (const hostId of pendingAcquisitionsRef.current.keys()) {
        retrySchedulerRef.current?.expedite(hostId)
      }
      for (const entry of storeRef.current.values()) {
        try {
          entry.client.notifyForeground(reason)
        } catch {
          // One broken physical session must not block recovery for other hosts.
        }
      }
    })
  }, [])

  const value = useMemo<RpcClientContextValue>(
    () => ({
      acquire,
      release,
      releaseAndCloseIfUnused,
      closeIfUnused,
      forceReconnect,
      refreshHostClient,
      forgetHostClient,
      disconnectHostClient,
      ...selectors,
      subscribeHostState,
      getAllClients,
      subscribeAllHosts,
      primeHosts
    }),
    [
      acquire,
      release,
      releaseAndCloseIfUnused,
      closeIfUnused,
      forceReconnect,
      refreshHostClient,
      forgetHostClient,
      disconnectHostClient,
      selectors,
      subscribeHostState,
      getAllClients,
      subscribeAllHosts,
      primeHosts
    ]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useRpcClientContext(): RpcClientContextValue {
  const ctx = useContext(Ctx)
  if (!ctx) {
    throw new Error('useHostClient must be used inside <RpcClientProvider>')
  }
  return ctx
}

// Primary hook for screens: acquires the shared client on mount, releases on unmount, re-renders on state change.
export function useHostClient(hostId: string | undefined): {
  client: RpcClient | null
  state: ConnectionState
} {
  const ctx = useRpcClientContext()
  const [, force] = useState(0)
  // Why: an absent entry at mount is almost always the open racing the render, not a
  // dead host — seed amber; a failed open notifies 'disconnected' moments later.
  const [state, setState] = useState<ConnectionState>(() =>
    hostId ? (ctx.getKnownState(hostId) ?? 'connecting') : 'disconnected'
  )
  const clientRef = useRef<RpcClient | null>(null)
  const clientHostIdRef = useRef<string | undefined>(hostId)
  const acquisitionRef = useRef<HostClientAcquisition>({})

  useEffect(() => {
    if (!hostId) {
      clientRef.current = null
      clientHostIdRef.current = undefined
      setState('disconnected')
      return
    }
    clientHostIdRef.current = hostId
    let cancelled = false
    // Subscribe before acquire so any state change during open is captured.
    const unsub = ctx.subscribeHostState(hostId, (next) => {
      if (cancelled) {
        return
      }
      setState(next)
      // Why: async open and forceReconnect swap the client object; re-read each state change so screens never drive a stale one.
      const found = ctx.getAllClients().find((entry) => entry.hostId === hostId)
      if (found && found.client !== clientRef.current) {
        clientRef.current = found.client
        force((n) => n + 1)
      } else if (!found && clientRef.current) {
        // Why: disconnect/forget deletes the entry; never retain a dead client (STA-1511).
        clientRef.current = null
        force((n) => n + 1)
      }
    })
    const initial = ctx.acquire(hostId, acquisitionRef.current)
    clientRef.current = initial
    setState(ctx.getKnownState(hostId) ?? 'connecting')
    if (initial) {
      // Why: two cached hosts can both be connected, so equal state values cannot reveal the replacement client.
      force((n) => n + 1)
    }
    return () => {
      cancelled = true
      unsub()
      ctx.release(hostId, acquisitionRef.current)
      clientRef.current = null
      clientHostIdRef.current = undefined
    }
  }, [ctx, hostId])

  // Why: Expo can reuse the screen before effects bind the next host; never expose the prior host's client or state in that render.
  const bound = clientHostIdRef.current === hostId
  const boundState = bound
    ? state
    : hostId
      ? (ctx.getKnownState(hostId) ?? 'connecting')
      : 'disconnected'
  return { client: bound ? clientRef.current : null, state: boundState }
}

// Why: host-store's removeHost() must close the live client but has no React-side handle; this hook bridges to it.
export function useRefreshHostClient(): (hostId: string) => void {
  const ctx = useRpcClientContext()
  return ctx.refreshHostClient
}

export function useForgetHostClient(): (hostId: string) => void {
  const ctx = useRpcClientContext()
  return ctx.forgetHostClient
}

export function useDisconnectHostClient(): (hostId: string) => void {
  const ctx = useRpcClientContext()
  return ctx.disconnectHostClient
}

// Why: future-proof "Connection issues — try again" affordance.
export function useForceReconnect(): (hostId: string) => Promise<void> {
  const ctx = useRpcClientContext()
  return ctx.forceReconnect
}

// Why: primes already-loaded HostProfiles so the provider can skip a second loadHosts()/Keychain pass on cold start.
export function usePrimeHosts(): (hosts: HostProfile[]) => void {
  const ctx = useRpcClientContext()
  return ctx.primeHosts
}
