import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { focusManager, useQueryClient, type Query, type QueryClient } from '@tanstack/react-query'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import {
  subscribeSharedClientEvents,
  type SharedClientEvent
} from '../transport/connection/shared-client-events'
import type { HostQuerySignal, HostSignalEvent } from './host-query'
import { hostScopeKey, type HostQueryKey } from './host-query-key'

function signalOf(query: Query): HostQuerySignal | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: hostQueryOptions writes `signal` from the family's HostQuerySignal.
  return query.meta?.signal as HostQuerySignal | undefined
}

function targetOf(query: Query): HostQueryKey[3] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: signalledQueries scans only host-scoped keys, which hostQueryKey builds.
  return (query.queryKey as HostQueryKey)[3]
}

// What to do once a read already out settles: read again, or only mark the answer stale.
type AfterRead = 'refetch' | 'stale'

const afterReads = new WeakMap<QueryClient, Map<string, AfterRead>>()

function afterReadsOf(queryClient: QueryClient): Map<string, AfterRead> {
  const existing = afterReads.get(queryClient)
  if (existing) {
    return existing
  }
  const pending = new Map<string, AfterRead>()
  afterReads.set(queryClient, pending)
  // One cache listener per world, for as long as the world's client lives.
  queryClient.getQueryCache().subscribe(({ type, query }) => {
    const after = pending.get(query.queryHash)
    if (type === 'updated' && after && query.state.fetchStatus === 'idle') {
      pending.delete(query.queryHash)
      if (after === 'refetch') {
        refetchHostQueryAfterInFlight(queryClient, query)
      } else {
        void markStale(queryClient, query)
      }
    }
  })
  return pending
}

function markStale(queryClient: QueryClient, query: Query): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: query.queryKey,
    exact: true,
    refetchType: 'none'
  })
}

// A read already out may predate the change, and its answer would clear the mark; mark again once it lands.
function markStaleAfterInFlight(queryClient: QueryClient, query: Query): void {
  void markStale(queryClient, query)
  const pending = afterReadsOf(queryClient)
  if (query.state.fetchStatus === 'fetching' && !pending.has(query.queryHash)) {
    pending.set(query.queryHash, 'stale')
  }
}

/**
 * Reads an observed query again, after the read already out settles if there is one: that read may
 * have been sent before the change that asked. TanStack's own refetch would join it or cancel it.
 */
export function refetchHostQueryAfterInFlight(queryClient: QueryClient, query: Query): void {
  if (query.state.fetchStatus === 'fetching') {
    afterReadsOf(queryClient).set(query.queryHash, 'refetch')
    return
  }
  void queryClient.refetchQueries(
    { queryKey: query.queryKey, exact: true, type: 'active' },
    { cancelRefetch: false }
  )
}

type RouterHandle = {
  stop: () => void
  isReady: () => boolean
  onReadyChange: (listener: () => void) => () => void
}

function startHostEventRouter(
  queryClient: QueryClient,
  hostId: string,
  client: RpcClient
): RouterHandle {
  const startedAt = Date.now()
  // Whether the stream is live now, i.e. a change on the host would reach this router.
  let ready = false
  const readyListeners = new Set<() => void>()
  const setReady = (next: boolean): void => {
    if (next !== ready) {
      ready = next
      readyListeners.forEach((listener) => listener())
    }
  }
  // When the stream last said it was live (0: never); a replayed ready may have missed events since.
  let readyAt = 0
  const floorTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const signalledQueries = (matches: (signal: HostQuerySignal, query: Query) => boolean): Query[] =>
    queryClient.getQueryCache().findAll({
      queryKey: hostScopeKey(hostId),
      predicate: (query) => {
        const signal = signalOf(query)
        return signal !== undefined && matches(signal, query)
      }
    })
  // Unobserved or hidden: stale only, so the next mount or foreground reads it.
  const readsNow = (query: Query): boolean => query.isActive() && focusManager.isFocused()

  const onChange = (query: Query): void => {
    markStaleAfterInFlight(queryClient, query)
    if (!readsNow(query) || floorTimers.has(query.queryHash)) {
      return
    }
    // Change events can come per agent step; keep reads `floorMs` apart, polls and reads in flight included.
    const lastReadAt =
      query.state.fetchStatus === 'fetching' ? Date.now() : query.state.dataUpdatedAt
    const wait = lastReadAt + (signalOf(query)?.floorMs ?? 0) - Date.now()
    if (wait <= 0) {
      refetchHostQueryAfterInFlight(queryClient, query)
      return
    }
    floorTimers.set(
      query.queryHash,
      setTimeout(() => {
        floorTimers.delete(query.queryHash)
        if (readsNow(query)) {
          refetchHostQueryAfterInFlight(queryClient, query)
        }
      }, wait)
    )
  }

  // Reads again (or marks stale, when no one watches) every answer older than `readSince`.
  const catchUp = (readSince: number): void => {
    for (const query of signalledQueries(() => true)) {
      if (query.state.fetchStatus === 'fetching' || query.state.dataUpdatedAt >= readSince) {
        continue
      }
      if (readsNow(query)) {
        void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true })
      } else {
        void markStale(queryClient, query)
      }
    }
  }

  const onReplayedReady = (missedSince: number): void => {
    // After a reconnect, the connected edge already re-read every observed query; a replay with no reconnect (a path switch) did not.
    const connectedAt = client.getLastConnectedAt() ?? 0
    catchUp(connectedAt > missedSince ? connectedAt : Infinity)
  }

  const onEvent = (event: SharedClientEvent): void => {
    if (event.type === 'ready') {
      // Events are not queued while disconnected or between a stream's end and its reopen.
      if ('replayed' in event) {
        onReplayedReady(readyAt)
      } else if (readyAt === 0) {
        // Answers cached before this router started were read while nothing heard the host.
        catchUp(startedAt)
      }
      readyAt = Date.now()
      setReady(true)
      return
    }
    if (event.type === 'end' || event.type === 'error') {
      // The shared stream opens again by itself; its next ready re-reads what was missed.
      setReady(false)
      return
    }
    const signalled: HostSignalEvent = event
    const named = (signal: HostQuerySignal, query: Query): boolean =>
      signal.events.includes(signalled.type) &&
      (signal.matches?.(signalled, targetOf(query)) ?? true)
    for (const query of signalledQueries(named)) {
      onChange(query)
    }
  }

  const stopStream = subscribeSharedClientEvents(client, onEvent)
  return {
    stop: () => {
      stopStream()
      for (const timer of floorTimers.values()) {
        clearTimeout(timer)
      }
      floorTimers.clear()
      readyListeners.clear()
    },
    isReady: () => ready,
    onReadyChange: (listener) => {
      readyListeners.add(listener)
      return () => readyListeners.delete(listener)
    }
  }
}

type Router = { holders: number; handle: RouterHandle }

const routers = new WeakMap<QueryClient, Map<RpcClient, Router>>()

// One router per world per host client, however many screens read that host.
function retainHostEventRouter(
  queryClient: QueryClient,
  hostId: string,
  client: RpcClient
): { handle: RouterHandle; release: () => void } {
  let byClient = routers.get(queryClient)
  if (!byClient) {
    byClient = new Map()
    routers.set(queryClient, byClient)
  }
  const clients = byClient
  let router = clients.get(client)
  if (!router) {
    router = { holders: 0, handle: startHostEventRouter(queryClient, hostId, client) }
    clients.set(client, router)
  }
  const held = router
  held.holders += 1
  const release = (): void => {
    held.holders -= 1
    if (held.holders === 0) {
      held.handle.stop()
      clients.delete(client)
    }
  }
  return { handle: held.handle, release }
}

/** Keeps the host's event-signalled families (see HostQuery `signal`) fresh while a screen reads them. */
export function useHostEventRouter(hostId: string | undefined, client: RpcClient | null): void {
  const queryClient = useQueryClient()
  useEffect(
    () =>
      client && hostId ? retainHostEventRouter(queryClient, hostId, client).release : undefined,
    [queryClient, hostId, client]
  )
}

/**
 * Keeps the host's event router running, like useHostEventRouter, and says whether its event stream
 * is live. Only while it is can a family hold its answer until an event marks it stale.
 */
export function useHostEventStreamReady(
  hostId: string | undefined,
  client: RpcClient | null
): boolean {
  const queryClient = useQueryClient()
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!client || !hostId) {
        return () => {}
      }
      const { handle, release } = retainHostEventRouter(queryClient, hostId, client)
      const stopListening = handle.onReadyChange(onChange)
      return () => {
        stopListening()
        release()
      }
    },
    [queryClient, hostId, client]
  )
  return useSyncExternalStore(subscribe, () =>
    client && hostId ? (routers.get(queryClient)?.get(client)?.handle.isReady() ?? false) : false
  )
}
