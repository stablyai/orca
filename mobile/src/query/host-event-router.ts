import { useEffect } from 'react'
import { focusManager, useQueryClient, type Query, type QueryClient } from '@tanstack/react-query'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import {
  subscribeSharedClientEvents,
  type SharedClientEvent
} from '../transport/connection/shared-client-events'
import type { HostQuerySignal } from './host-query'
import { hostScopeKey } from './host-query-key'

function signalOf(query: Query): HostQuerySignal | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: hostQueryOptions writes `signal` from the family's HostQuerySignal.
  return query.meta?.signal as HostQuerySignal | undefined
}

const trailingReads = new WeakMap<QueryClient, Set<string>>()

function trailingReadsOf(queryClient: QueryClient): Set<string> {
  const existing = trailingReads.get(queryClient)
  if (existing) {
    return existing
  }
  const hashes = new Set<string>()
  trailingReads.set(queryClient, hashes)
  // One cache listener per world, for as long as the world's client lives.
  queryClient.getQueryCache().subscribe(({ type, query }) => {
    if (type === 'updated' && hashes.has(query.queryHash) && query.state.fetchStatus === 'idle') {
      hashes.delete(query.queryHash)
      refetchHostQueryAfterInFlight(queryClient, query)
    }
  })
  return hashes
}

/**
 * Reads an observed query again, after the read already out settles if there is one: that read may
 * have been sent before the change that asked. TanStack's own refetch would join it or cancel it.
 */
export function refetchHostQueryAfterInFlight(queryClient: QueryClient, query: Query): void {
  if (query.state.fetchStatus === 'fetching') {
    trailingReadsOf(queryClient).add(query.queryHash)
    return
  }
  void queryClient.refetchQueries(
    { queryKey: query.queryKey, exact: true, type: 'active' },
    { cancelRefetch: false }
  )
}

function startHostEventRouter(
  queryClient: QueryClient,
  hostId: string,
  client: RpcClient
): () => void {
  // When the stream last said it was live; a replayed ready may have missed events since.
  let readyAt = 0
  const floorTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const signalledQueries = (matches: (signal: HostQuerySignal) => boolean): Query[] =>
    queryClient.getQueryCache().findAll({
      queryKey: hostScopeKey(hostId),
      predicate: (query) => {
        const signal = signalOf(query)
        return signal !== undefined && matches(signal)
      }
    })
  const markStale = (query: Query): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true, refetchType: 'none' })
  // Unobserved or hidden: stale only, so the next mount or foreground reads it.
  const readsNow = (query: Query): boolean => query.isActive() && focusManager.isFocused()

  const onChange = (query: Query): void => {
    void markStale(query)
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

  const onReplayedReady = (missedSince: number): void => {
    // After a reconnect, the connected edge already re-read every observed query; a replay with no reconnect (a path switch) did not.
    const connectedAt = client.getLastConnectedAt() ?? 0
    const readSince = connectedAt > missedSince ? connectedAt : Infinity
    for (const query of signalledQueries(() => true)) {
      if (query.state.fetchStatus === 'fetching' || query.state.dataUpdatedAt >= readSince) {
        continue
      }
      if (readsNow(query)) {
        void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true })
      } else {
        void markStale(query)
      }
    }
  }

  const onEvent = (event: SharedClientEvent): void => {
    if (event.type === 'ready') {
      // Events are not queued while disconnected or between a stream's end and its reopen.
      if ('replayed' in event) {
        onReplayedReady(readyAt)
      }
      readyAt = Date.now()
      return
    }
    if (event.type === 'end' || event.type === 'error') {
      // The shared stream opens again by itself; its next ready re-reads what was missed.
      return
    }
    const eventType = event.type
    for (const query of signalledQueries((signal) => signal.events.includes(eventType))) {
      onChange(query)
    }
  }

  const stopStream = subscribeSharedClientEvents(client, onEvent)
  return () => {
    stopStream()
    for (const timer of floorTimers.values()) {
      clearTimeout(timer)
    }
    floorTimers.clear()
  }
}

type Router = { holders: number; stop: () => void }

const routers = new WeakMap<QueryClient, Map<RpcClient, Router>>()

// One router per world per host client, however many screens read that host.
function retainHostEventRouter(
  queryClient: QueryClient,
  hostId: string,
  client: RpcClient
): () => void {
  let byClient = routers.get(queryClient)
  if (!byClient) {
    byClient = new Map()
    routers.set(queryClient, byClient)
  }
  const clients = byClient
  let router = clients.get(client)
  if (!router) {
    router = { holders: 0, stop: startHostEventRouter(queryClient, hostId, client) }
    clients.set(client, router)
  }
  const held = router
  held.holders += 1
  return () => {
    held.holders -= 1
    if (held.holders === 0) {
      held.stop()
      clients.delete(client)
    }
  }
}

/** Keeps the host's event-signalled families (see HostQuery `signal`) fresh while a screen reads them. */
export function useHostEventRouter(hostId: string | undefined, client: RpcClient | null): void {
  const queryClient = useQueryClient()
  useEffect(
    () => (client && hostId ? retainHostEventRouter(queryClient, hostId, client) : undefined),
    [queryClient, hostId, client]
  )
}
