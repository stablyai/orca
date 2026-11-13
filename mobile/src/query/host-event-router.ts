import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { focusManager, useQueryClient, type Query, type QueryClient } from '@tanstack/react-query'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import {
  subscribeSharedClientEvents,
  type SharedClientEvent
} from '../transport/connection/shared-client-events'
import type { HostQuerySignal, HostSignalEvent } from './host-query'
import { hostScopeKey, type HostQueryKey } from './host-query-key'
import { HostReadGate } from '../../../src/shared/remote-runtime/host-change-read-gate'

function signalOf(query: Query): HostQuerySignal | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: hostQueryOptions writes `signal` from the family's HostQuerySignal.
  return query.meta?.signal as HostQuerySignal | undefined
}

function targetOf(query: Query): HostQueryKey[3] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: signalledQueries scans only host-scoped keys, which hostQueryKey builds.
  return (query.queryKey as HostQueryKey)[3]
}

const gates = new WeakMap<QueryClient, Map<string, HostReadGate>>()

function readsNow(query: Query): boolean {
  // Unobserved or hidden: stale only, so the next mount or foreground reads it.
  return query.isActive() && focusManager.isFocused()
}

function gatesOf(queryClient: QueryClient): Map<string, HostReadGate> {
  const existing = gates.get(queryClient)
  if (existing) {
    return existing
  }
  const byQuery = new Map<string, HostReadGate>()
  gates.set(queryClient, byQuery)
  // One cache listener per world: TanStack's own reads (mounts, polls, focus) count toward the floor too.
  queryClient.getQueryCache().subscribe(({ type, query }) => {
    const gate = byQuery.get(query.queryHash)
    if (!gate) {
      return
    }
    if (type === 'removed') {
      gate.dispose()
      byQuery.delete(query.queryHash)
    } else if (query.state.fetchStatus === 'fetching') {
      gate.readStarted()
    } else {
      gate.readSettled()
    }
  })
  return byQuery
}

/** The query's read gate (host-change-read-gate), started from what TanStack already read. */
function gateOf(queryClient: QueryClient, query: Query): HostReadGate {
  const byQuery = gatesOf(queryClient)
  const existing = byQuery.get(query.queryHash)
  if (existing) {
    return existing
  }
  const { fetchStatus, dataUpdatedAt, errorUpdatedAt } = query.state
  const settledAt = Math.max(dataUpdatedAt, errorUpdatedAt)
  const gate: HostReadGate = new HostReadGate(
    {
      floorMs: signalOf(query)?.floorMs ?? 0,
      read: () => {
        void queryClient.refetchQueries(
          { queryKey: query.queryKey, exact: true, type: 'active' },
          { cancelRefetch: false }
        )
        // An inactive query starts no read.
        if (query.state.fetchStatus !== 'fetching') {
          gate.readSettled()
        }
      },
      watching: () => readsNow(query),
      // The connected edge re-reads every observed query (host-connection-invalidation).
      connected: () => true,
      onStale: () =>
        void queryClient.invalidateQueries({
          queryKey: query.queryKey,
          exact: true,
          refetchType: 'none'
        })
    },
    {
      inFlight: fetchStatus === 'fetching',
      startedAt: fetchStatus === 'fetching' ? Date.now() : dataUpdatedAt,
      settledAt
    }
  )
  byQuery.set(query.queryHash, gate)
  return gate
}

/**
 * Reads an observed query again, after the read already out settles if there is one: that read may
 * have been sent before the change that asked. TanStack's own refetch would join it or cancel it.
 */
export function refetchHostQueryAfterInFlight(queryClient: QueryClient, query: Query): void {
  gateOf(queryClient, query).request()
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
  const signalledQueries = (matches: (signal: HostQuerySignal, query: Query) => boolean): Query[] =>
    queryClient.getQueryCache().findAll({
      queryKey: hostScopeKey(hostId),
      predicate: (query) => {
        const signal = signalOf(query)
        return signal !== undefined && matches(signal, query)
      }
    })

  // `since` Infinity is a stream reopened on the same connection: a read already out may predate the gap.
  const catchUp = (since: number): void => {
    for (const query of signalledQueries(() => true)) {
      gateOf(queryClient, query).live(since)
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
      gateOf(queryClient, query).changed()
    }
  }

  const stopStream = subscribeSharedClientEvents(client, onEvent)
  return {
    stop: () => {
      stopStream()
      for (const query of signalledQueries(() => true)) {
        gates.get(queryClient)?.get(query.queryHash)?.dispose()
      }
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
export function retainHostEventRouter(
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
