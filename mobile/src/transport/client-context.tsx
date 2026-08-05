import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import type { RpcClient } from './rpc-client'
import { connectionLogStore } from './connection-log-buffer'
import { HostForceReconnectCoordinator, type HostReconnectEntry } from './host-force-reconnect'
import { HostReconnectProfileCache, type HostOpenProfile } from './host-reconnect-profile-cache'
import { subscribeConnectionRevivalTriggers } from './connection-revival-triggers'
import { HostClientOpenRegistry } from './host-client-open-registry'
import { cancelHostClientOpenProfile, loadHostClientOpenProfile } from './host-client-open-profile'
import { getHostListLoadRevision } from './host-list-load-sharing'
import { loadHosts } from './host-store'
import { openHostLogicalClient } from './host-logical-client'
import { clientActivePath } from './rpc-client-active-path'
import type { RpcClientContextValue } from './rpc-client-context-contract'
import type { MobileConnectionPath } from './stable-logical-rpc-client'
import type { ConnectionLogSink, ConnectionState, HostProfile } from './types'
import { RpcApplicationResponsiveness } from './rpc-application-responsiveness'
import { RpcClientContextBoundary } from './rpc-client-react-context'
export { useRpcClientContext } from './rpc-client-react-context'

type StoreEntry = HostReconnectEntry & { state: ConnectionState }

export function RpcClientProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<Map<string, StoreEntry>>(new Map())
  const stateListenersRef = useRef<Map<string, Set<(state: ConnectionState) => void>>>(new Map())
  const allHostsListenersRef = useRef<Set<() => void>>(new Set())

  const pendingOpensRef = useRef(new HostClientOpenRegistry())
  const forceReconnectCoordinatorRef = useRef(new HostForceReconnectCoordinator())

  const primedHostsRef = useRef(new HostReconnectProfileCache())
  const responsivenessRef = useRef(new Map<string, RpcApplicationResponsiveness>())

  function getHostResponsiveness(hostId: string): RpcApplicationResponsiveness {
    let responsiveness = responsivenessRef.current.get(hostId)
    if (!responsiveness) {
      responsiveness = new RpcApplicationResponsiveness()
      // Why: latch/recovery re-renders host subscribers through the existing
      // state channel — the unresponsive verdict needs no UI polling.
      responsiveness.subscribe(() => {
        const entry = storeRef.current.get(hostId)
        notifyHostState(hostId, entry?.state ?? 'disconnected')
      })
      responsivenessRef.current.set(hostId, responsiveness)
    }
    return responsiveness
  }

  function notifyHostState(hostId: string, state: ConnectionState) {
    const set = stateListenersRef.current.get(hostId)
    if (!set) {
      return
    }
    for (const listener of set) {
      listener(state)
    }
  }

  function notifyAllHosts() {
    for (const listener of allHostsListenersRef.current) {
      listener()
    }
  }

  const closeEntry = useCallback((hostId: string) => {
    pendingOpensRef.current.cancel(hostId)
    forceReconnectCoordinatorRef.current.cancel(hostId)
    primedHostsRef.current.delete(hostId)
    responsivenessRef.current.delete(hostId)
    const entry = storeRef.current.get(hostId)
    entry?.unsubState()
    storeRef.current.delete(hostId)
    entry?.client.close()
    notifyHostState(hostId, 'disconnected')
    notifyAllHosts()
  }, [])

  const openEntry = useCallback(
    async (hostId: string, requestedProfile?: HostOpenProfile): Promise<StoreEntry | null> => {
      const currentRevision = getHostListLoadRevision()
      const profileVersion =
        requestedProfile?.version ?? primedHostsRef.current.version(hostId, currentRevision)
      const existing = pendingOpensRef.current.getActivePromise(hostId, profileVersion)
      if (existing) {
        await existing
        return storeRef.current.get(hostId) ?? null
      }
      let resolve: () => void = () => {}
      const promise = new Promise<void>((res) => {
        resolve = res
      })
      const pendingOpen = pendingOpensRef.current.register(hostId, profileVersion, promise)
      notifyHostState(hostId, 'connecting')

      try {
        const onUnavailable = () => {
          notifyHostState(hostId, 'disconnected')
          notifyAllHosts()
        }
        const loadProfile = () =>
          loadHostClientOpenProfile({
            hostId,
            cache: primedHostsRef.current,
            ticket: pendingOpen,
            loadHosts,
            onUnavailable
          })
        let profile: HostOpenProfile | null = primedHostsRef.current.openProfile(
          hostId,
          currentRevision,
          requestedProfile
        )
        if (!profile.host) {
          profile = await loadProfile()
        }
        while (profile && profile.sourceRevision !== getHostListLoadRevision()) {
          profile = await loadProfile()
        }
        if (!profile?.host || pendingOpen.cancelled) {
          return null
        }
        pendingOpen.profileVersion = profile.version

        const after = storeRef.current.get(hostId)
        if (after) {
          return after
        }

        let client: RpcClient
        const onLog: ConnectionLogSink = (entry) => connectionLogStore.append(hostId, entry)
        try {
          client = openHostLogicalClient(
            profile.host,
            onLog,
            primedHostsRef.current.publisher(hostId, profile.version, getHostListLoadRevision),
            getHostResponsiveness(hostId)
          )
        } catch {
          // Why: openHostLogicalClient can throw synchronously (bad public key / invalid URL); notify so the UI leaves 'connecting'.
          notifyHostState(hostId, 'disconnected')
          notifyAllHosts()
          return null
        }
        const unsubState = client.onStateChange((state) => {
          const cur = storeRef.current.get(hostId)
          if (!cur) {
            return
          }
          cur.state = state
          notifyHostState(hostId, state)
        })
        const entry: StoreEntry = {
          client,
          state: client.getState(),
          refCount: 0,
          unsubState
        }
        storeRef.current.set(hostId, entry)
        notifyHostState(hostId, entry.state)
        notifyAllHosts()
        return entry
      } finally {
        pendingOpensRef.current.deleteIfCurrent(hostId, pendingOpen)
        resolve()
      }
    },
    []
  )

  const acquire = useCallback(
    (hostId: string, host?: HostProfile): RpcClient | null => {
      if (host) {
        primedHostsRef.current.prime(host, getHostListLoadRevision())
      }
      const existing = storeRef.current.get(hostId)
      if (existing) {
        existing.refCount += 1
        return existing.client
      }
      void openEntry(hostId).then((entry) => {
        if (!entry) {
          return
        }
        entry.refCount += 1
      })
      return null
    },
    [openEntry]
  )

  const primeHosts = useCallback((hosts: HostProfile[], sourceRevision: number) => {
    primedHostsRef.current.primeLoadedHosts(hosts, sourceRevision, getHostListLoadRevision())
  }, [])

  // Why: no idle-close on refcount→0 — transient nav gaps flashed false 'disconnected', so keep sockets alive while foregrounded.
  const release = useCallback((hostId: string) => {
    const entry = storeRef.current.get(hostId)
    if (!entry) {
      return
    }
    entry.refCount = Math.max(0, entry.refCount - 1)
  }, [])

  const runForceReconnect = useCallback(
    (hostId: string, profile: HostOpenProfile): Promise<void> => {
      return forceReconnectCoordinatorRef.current.run({
        hostId,
        profileVersion: profile.version,
        getEntry: () => storeRef.current.get(hostId),
        getListenerCount: () => stateListenersRef.current.get(hostId)?.size ?? 0,
        removeEntry: (expected) => {
          if (storeRef.current.get(hostId) !== expected) {
            return
          }
          storeRef.current.delete(hostId)
          notifyHostState(hostId, 'disconnected')
          notifyAllHosts()
        },
        cancelPendingOpen: () => cancelHostClientOpenProfile(pendingOpensRef.current, hostId),
        openReplacement: () => openEntry(hostId, profile)
      })
    },
    [openEntry]
  )

  const forceReconnect = useCallback(
    (hostId: string, requestedHost?: HostProfile): Promise<void> => {
      const profile = primedHostsRef.current.reconnectProfile(
        hostId,
        getHostListLoadRevision(),
        requestedHost
      )
      return runForceReconnect(hostId, profile)
    },
    [runForceReconnect]
  )

  const forceReconnectAfterEdit = useCallback(
    (
      hostId: string,
      fallbackHost: HostProfile,
      updates: { name?: string; endpoint?: string }
    ): Promise<void> => {
      const profile = primedHostsRef.current.reconnectEditedProfile(
        hostId,
        getHostListLoadRevision(),
        fallbackHost,
        updates
      )
      return runForceReconnect(hostId, profile)
    },
    [runForceReconnect]
  )

  // null = no entry and no open in flight; callers pick their own default.
  const getKnownState = useCallback((hostId: string): ConnectionState | null => {
    const entry = storeRef.current.get(hostId)
    if (entry) {
      return entry.state
    }
    // Why: the async open (a Keychain pass) predates the store entry; reading that
    // window as 'disconnected' made every host screen flash dead on mount (S2).
    return pendingOpensRef.current.hasActive(hostId) ? 'connecting' : null
  }, [])

  const getState = useCallback(
    (hostId: string): ConnectionState => getKnownState(hostId) ?? 'disconnected',
    [getKnownState]
  )

  const getReconnectAttempt = useCallback((hostId: string): number => {
    return storeRef.current.get(hostId)?.client.getReconnectAttempt() ?? 0
  }, [])

  const getLastConnectedAt = useCallback((hostId: string): number | null => {
    return storeRef.current.get(hostId)?.client.getLastConnectedAt() ?? null
  }, [])

  const getRpcUnresponsiveSince = useCallback((hostId: string): number | null => {
    return responsivenessRef.current.get(hostId)?.getUnresponsiveSince() ?? null
  }, [])

  const getActivePath = useCallback((hostId: string): MobileConnectionPath => {
    return clientActivePath(storeRef.current.get(hostId)?.client)
  }, [])

  const subscribeHostState = useCallback(
    (hostId: string, listener: (state: ConnectionState) => void) => {
      let set = stateListenersRef.current.get(hostId)
      if (!set) {
        set = new Set()
        stateListenersRef.current.set(hostId, set)
      }
      set.add(listener)
      return () => {
        const s = stateListenersRef.current.get(hostId)
        if (!s) {
          return
        }
        s.delete(listener)
        if (s.size === 0) {
          stateListenersRef.current.delete(hostId)
        }
      }
    },
    []
  )

  const getAllClients = useCallback((): {
    hostId: string
    client: RpcClient
  }[] => {
    const out: { hostId: string; client: RpcClient }[] = []
    for (const [hostId, entry] of storeRef.current) {
      out.push({ hostId, client: entry.client })
    }
    return out
  }, [])

  const subscribeAllHosts = useCallback((listener: () => void) => {
    allHostsListenersRef.current.add(listener)
    return () => {
      allHostsListenersRef.current.delete(listener)
    }
  }, [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const store = storeRef.current
    return () => {
      pendingOpensRef.current.cancelAll()
      forceReconnectCoordinatorRef.current.cancelAll()
      for (const [hostId] of store) {
        closeEntry(hostId)
      }
    }
  }, [])

  useEffect(() => {
    return subscribeConnectionRevivalTriggers((reason) => {
      for (const entry of storeRef.current.values()) {
        entry.client.notifyForeground(reason)
      }
    })
  }, [])

  const value = useMemo<RpcClientContextValue>(
    () => ({
      acquire,
      release,
      forceReconnect,
      forceReconnectAfterEdit,
      closeHost: closeEntry,
      getState,
      getKnownState,
      getReconnectAttempt,
      getLastConnectedAt,
      getRpcUnresponsiveSince,
      getActivePath,
      subscribeHostState,
      getAllClients,
      subscribeAllHosts,
      primeHosts
    }),
    [
      acquire,
      release,
      forceReconnect,
      forceReconnectAfterEdit,
      closeEntry,
      getState,
      getKnownState,
      getReconnectAttempt,
      getLastConnectedAt,
      getRpcUnresponsiveSince,
      getActivePath,
      subscribeHostState,
      getAllClients,
      subscribeAllHosts,
      primeHosts
    ]
  )

  return <RpcClientContextBoundary value={value}>{children}</RpcClientContextBoundary>
}

export { useHostClient } from './use-host-client'
export {
  useCloseHost,
  useForceReconnect,
  useForceReconnectAfterEdit,
  usePrimeHosts
} from './client-context-actions'
export { useAllHostClients } from './client-context-all-host-clients'
