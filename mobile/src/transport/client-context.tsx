// Why: collapses the per-screen WebSocket connection model into a single
// shared RpcClient per host. Implements the design in
// docs/mobile-shared-client-per-host.md.
//
// Lifecycle rules:
// - First request for a host opens its client lazily.
// - Refcount tracks active subscribers; when it drops to zero we schedule
//   a 30-second idle close timer. If a new subscriber arrives within that
//   window we cancel and reuse the same client.
// - removeHost() forces an immediate close so re-pairing gets a fresh
//   transport.
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
import { connect, type RpcClient } from './rpc-client'
import { loadHosts } from './host-store'
import type { ConnectionState, HostProfile } from './types'

type StoreEntry = {
  client: RpcClient
  state: ConnectionState
  refCount: number
  unsubState: () => void
}

type ContextValue = {
  acquire: (hostId: string, host?: HostProfile) => RpcClient | null
  release: (hostId: string) => void
  forceReconnect: (hostId: string) => Promise<void>
  closeHost: (hostId: string) => void
  getState: (hostId: string) => ConnectionState
  getReconnectAttempt: (hostId: string) => number
  // Why: timestamp (ms epoch) of the last successful 'connected' state
  // transition for this host, or null if never connected this session.
  // Used by the UI to escalate "Reconnecting…" into a "host appears
  // unreachable, re-pair?" prompt.
  getLastConnectedAt: (hostId: string) => number | null
  subscribeHostState: (hostId: string, listener: (state: ConnectionState) => void) => () => void
  getAllClients: () => Array<{ hostId: string; client: RpcClient }>
  subscribeAllHosts: (listener: () => void) => () => void
  // Why: lets the home screen feed already-loaded HostProfiles in so we
  // don't pay loadHosts() latency twice (once in the focus-effect, again
  // inside openEntry).
  primeHosts: (hosts: HostProfile[]) => void
}

const Ctx = createContext<ContextValue | null>(null)

export function RpcClientProvider({ children }: { children: ReactNode }) {
  // Why: entries live in a ref so updates don't force re-renders of the
  // entire tree on every connection state change. State propagation goes
  // through per-host listener Sets instead.
  const storeRef = useRef<Map<string, StoreEntry>>(new Map())
  const stateListenersRef = useRef<Map<string, Set<(state: ConnectionState) => void>>>(new Map())
  const allHostsListenersRef = useRef<Set<() => void>>(new Set())

  // Pending opens (avoid two acquire() callers in the same render racing the
  // host lookup). Keyed by hostId, value is a sentinel resolved when the
  // entry materialises.
  const pendingOpensRef = useRef<Map<string, Promise<void>>>(new Map())

  // Why: a fast-path cache of already-loaded HostProfiles. Screens that
  // have run loadHosts() can call primeHosts() to populate this and skip
  // the second loadHosts() inside openEntry. Without this we'd serialize
  // two Keychain passes on cold start.
  const primedHostsRef = useRef<Map<string, HostProfile>>(new Map())

  function notifyHostState(hostId: string, state: ConnectionState) {
    const set = stateListenersRef.current.get(hostId)
    if (!set) return
    for (const listener of set) listener(state)
  }

  function notifyAllHosts() {
    for (const listener of allHostsListenersRef.current) listener()
  }

  const closeEntry = useCallback((hostId: string) => {
    const entry = storeRef.current.get(hostId)
    if (!entry) return
    entry.unsubState()
    entry.client.close()
    storeRef.current.delete(hostId)
    notifyHostState(hostId, 'disconnected')
    notifyAllHosts()
  }, [])

  const openEntry = useCallback(async (hostId: string): Promise<StoreEntry | null> => {
    const existing = pendingOpensRef.current.get(hostId)
    if (existing) {
      await existing
      return storeRef.current.get(hostId) ?? null
    }
    let resolve: () => void = () => {}
    const promise = new Promise<void>((res) => {
      resolve = res
    })
    pendingOpensRef.current.set(hostId, promise)

    try {
      // Why: prefer the primed cache (populated by primeHosts when the
      // screen already ran loadHosts) so we don't serialize a second
      // Keychain pass behind the first one on cold start.
      let host = primedHostsRef.current.get(hostId)
      if (!host) {
        try {
          const hosts = await loadHosts()
          host = hosts.find((h) => h.id === hostId)
        } catch {
          // Why: a Keychain failure on cold start (rare but observed —
          // happens when iOS Keychain is mid-unlock or Android Keystore
          // races the JS bridge). Surface it as 'disconnected' so the
          // home card flips off the perma-spinner and the user can hit
          // Reconnect from the action sheet to retry.
          notifyHostState(hostId, 'disconnected')
          notifyAllHosts()
          return null
        }
        if (!host) return null
      }

      // Re-check after any await — another acquire() may have completed.
      const after = storeRef.current.get(hostId)
      if (after) return after

      let client: RpcClient
      try {
        client = connect(host.endpoint, host.deviceToken, host.publicKeyB64)
      } catch {
        // Why: connect() can throw synchronously if the public key is
        // malformed or the endpoint URL is invalid. Notify so the UI
        // doesn't sit on a stale 'connecting' label forever.
        notifyHostState(hostId, 'disconnected')
        notifyAllHosts()
        return null
      }
      const unsubState = client.onStateChange((state) => {
        const cur = storeRef.current.get(hostId)
        if (!cur) return
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
      pendingOpensRef.current.delete(hostId)
      resolve()
    }
  }, [])

  // Why: `acquire` is the synchronous get-or-open. If the entry already
  // exists, return its client immediately and bump the refcount. If not,
  // kick off an async open (the consumer will subscribe via
  // `subscribeHostState` and re-read once 'connecting' fires). Optionally
  // accepts the HostProfile so the caller can avoid an extra loadHosts()
  // pass inside openEntry.
  const acquire = useCallback(
    (hostId: string, host?: HostProfile): RpcClient | null => {
      if (host) primedHostsRef.current.set(hostId, host)
      const existing = storeRef.current.get(hostId)
      if (existing) {
        existing.refCount += 1
        return existing.client
      }
      // Trigger async open. The acquire-side will return null this tick and
      // try again once the state listener fires; consumers are expected to
      // call acquire() inside an effect that re-runs on state changes.
      void openEntry(hostId).then((entry) => {
        if (!entry) return
        entry.refCount += 1
      })
      return null
    },
    [openEntry]
  )

  const primeHosts = useCallback((hosts: HostProfile[]) => {
    for (const host of hosts) primedHostsRef.current.set(host.id, host)
  }, [])

  // Why: refcount dropping to 0 no longer triggers an idle-close. The
  // app deliberately keeps live WebSockets open while the app itself is
  // foregrounded — closing on transient navigation gaps was producing
  // false 'disconnected' flashes when the user navigated home → host →
  // back to home faster than React could re-acquire on the home side.
  // Connections still close on: explicit user Disconnect, host removal,
  // app backgrounding (OS-level socket suspension), and provider
  // unmount (app shutdown).
  const release = useCallback((hostId: string) => {
    const entry = storeRef.current.get(hostId)
    if (!entry) return
    entry.refCount = Math.max(0, entry.refCount - 1)
  }, [])

  const forceReconnect = useCallback(
    async (hostId: string) => {
      const entry = storeRef.current.get(hostId)
      // Why: preserve refcount across the swap. If the user reaches
      // forceReconnect via the Disconnect → Reconnect path, the entry
      // was already closed and refCount=0; fall back to active listener
      // count as a proxy for "screens still watching this host."
      const listenerCount = stateListenersRef.current.get(hostId)?.size ?? 0
      const savedRefCount = entry?.refCount ?? Math.max(1, listenerCount)
      if (entry) {
        entry.unsubState()
        entry.client.close()
        storeRef.current.delete(hostId)
      }
      const fresh = await openEntry(hostId)
      if (fresh) fresh.refCount = savedRefCount
    },
    [openEntry]
  )

  const getState = useCallback((hostId: string): ConnectionState => {
    return storeRef.current.get(hostId)?.state ?? 'disconnected'
  }, [])

  const getReconnectAttempt = useCallback((hostId: string): number => {
    return storeRef.current.get(hostId)?.client.getReconnectAttempt() ?? 0
  }, [])

  const getLastConnectedAt = useCallback((hostId: string): number | null => {
    return storeRef.current.get(hostId)?.client.getLastConnectedAt() ?? null
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
        if (!s) return
        s.delete(listener)
        if (s.size === 0) stateListenersRef.current.delete(hostId)
      }
    },
    []
  )

  const getAllClients = useCallback((): Array<{ hostId: string; client: RpcClient }> => {
    const out: Array<{ hostId: string; client: RpcClient }> = []
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

  // Close all clients on provider unmount (app shutdown).
  // Why: deps must be empty so this cleanup ONLY runs on real unmount.
  // Hot-reload re-evaluates this module, which makes closeEntry a new
  // function identity. With [closeEntry] as deps, every Fast Refresh
  // would tear down all open WebSockets, leaving screens holding closed
  // clients and the user staring at a 'Reconnecting…' card. Reading
  // storeRef.current and the locally-scoped closeEntry inside the
  // cleanup is safe — the ref is stable across renders, and the
  // function captured here will be the one defined in the same
  // closure as this effect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const store = storeRef.current
    return () => {
      for (const [hostId] of store) closeEntry(hostId)
    }
  }, [])

  const value = useMemo<ContextValue>(
    () => ({
      acquire,
      release,
      forceReconnect,
      closeHost: closeEntry,
      getState,
      getReconnectAttempt,
      getLastConnectedAt,
      subscribeHostState,
      getAllClients,
      subscribeAllHosts,
      primeHosts
    }),
    [
      acquire,
      release,
      forceReconnect,
      closeEntry,
      getState,
      getReconnectAttempt,
      getLastConnectedAt,
      subscribeHostState,
      getAllClients,
      subscribeAllHosts,
      primeHosts
    ]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

function useCtx(): ContextValue {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useHostClient must be used inside <RpcClientProvider>')
  return ctx
}

// Why: the primary hook for screens. Acquires the shared client for a
// hostId on mount and releases on unmount. Re-renders when the host's
// connection state changes.
export function useHostClient(hostId: string | undefined): {
  client: RpcClient | null
  state: ConnectionState
} {
  const ctx = useCtx()
  const [, force] = useState(0)
  const [state, setState] = useState<ConnectionState>(() =>
    hostId ? ctx.getState(hostId) : 'disconnected'
  )
  const clientRef = useRef<RpcClient | null>(null)

  useEffect(() => {
    if (!hostId) {
      clientRef.current = null
      setState('disconnected')
      return
    }
    let cancelled = false
    // Subscribe before acquire so any state change during open is captured.
    const unsub = ctx.subscribeHostState(hostId, (next) => {
      if (cancelled) return
      setState(next)
      // Why: if the client was null at first acquire (async open), the
      // first state change ('connecting'/'handshaking'/'connected') is our
      // signal to re-read.
      if (clientRef.current == null) {
        const all = ctx.getAllClients()
        const found = all.find((entry) => entry.hostId === hostId)
        if (found) {
          clientRef.current = found.client
          force((n) => n + 1)
        }
      }
    })
    const initial = ctx.acquire(hostId)
    if (initial) {
      clientRef.current = initial
      setState(ctx.getState(hostId))
    }
    return () => {
      cancelled = true
      unsub()
      ctx.release(hostId)
      clientRef.current = null
    }
  }, [ctx, hostId])

  return { client: clientRef.current, state }
}

// Why: home screen renders all paired hosts at once. Acquires each on
// mount, releases on unmount. The provider's refcounting ensures we
// don't double-open if a host-detail screen is also open.
export function useAllHostClients(hostIds: string[]): Array<{
  hostId: string
  client: RpcClient
  state: ConnectionState
}> {
  const ctx = useCtx()
  // Stable key so we don't tear down on every render of the array.
  const key = useMemo(() => [...hostIds].sort().join(','), [hostIds])
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (hostIds.length === 0) return
    for (const id of hostIds) ctx.acquire(id)
    const unsubs: Array<() => void> = []
    for (const id of hostIds) {
      unsubs.push(ctx.subscribeHostState(id, () => setTick((n) => n + 1)))
    }
    unsubs.push(ctx.subscribeAllHosts(() => setTick((n) => n + 1)))
    return () => {
      for (const u of unsubs) u()
      for (const id of hostIds) ctx.release(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return useMemo(() => {
    const out: Array<{ hostId: string; client: RpcClient; state: ConnectionState }> = []
    for (const id of hostIds) {
      const all = ctx.getAllClients().find((entry) => entry.hostId === id)
      if (all) {
        out.push({ hostId: id, client: all.client, state: ctx.getState(id) })
      }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick])
}

// Why: removeHost() in host-store.ts must close the live client, but
// host-store has no React-side handle. Expose a hook that lets callers
// close a host after removal.
export function useCloseHost(): (hostId: string) => void {
  const ctx = useCtx()
  return ctx.closeHost
}

// Why: future-proof "Connection issues — try again" affordance.
export function useForceReconnect(): (hostId: string) => Promise<void> {
  const ctx = useCtx()
  return ctx.forceReconnect
}

// Why: lets the home screen feed already-loaded HostProfiles in so the
// provider can skip its own loadHosts() pass when it eventually opens
// each host — collapses two serial Keychain reads on cold-start into one.
export function usePrimeHosts(): (hosts: HostProfile[]) => void {
  const ctx = useCtx()
  return ctx.primeHosts
}

// Why: lets the home/host-detail UI escalate "Reconnecting…" to a more
// alarming "Can't connect" once the rpc-client has cycled enough times to
// indicate something's actually wrong (wrong port, server down, network
// loss). Reads through the context so it stays in sync with the live
// rpc-client instance even after forceReconnect swaps the underlying
// client.
export function useReconnectAttempt(hostId: string | undefined): number {
  const ctx = useCtx()
  const [, force] = useState(0)
  useEffect(() => {
    if (!hostId) return
    return ctx.subscribeHostState(hostId, () => force((n) => n + 1))
  }, [ctx, hostId])
  return hostId ? ctx.getReconnectAttempt(hostId) : 0
}

// Why: timestamp of last successful connect for this host, or null if
// the client has never connected. Combined with reconnectAttempt this
// distinguishes "transient blip" (recently connected) from "host
// appears unreachable" (never connected, or hasn't connected in N
// seconds despite many retry attempts).
export function useLastConnectedAt(hostId: string | undefined): number | null {
  const ctx = useCtx()
  const [, force] = useState(0)
  useEffect(() => {
    if (!hostId) return
    return ctx.subscribeHostState(hostId, () => force((n) => n + 1))
  }, [ctx, hostId])
  return hostId ? ctx.getLastConnectedAt(hostId) : null
}
