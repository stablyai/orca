import { useMemo } from 'react'
import {
  hashKey,
  notifyManager,
  queryOptions,
  skipToken,
  useQueries,
  useQuery,
  type QueryClient,
  type StaleTimeFunction,
  type UseQueryOptions,
  type UseQueryResult
} from '@tanstack/react-query'
import type { RuntimeClientEventStreamMessage } from '../../../src/shared/runtime-client-events'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { useHostConnectionInvalidation } from './host-connection-invalidation'
import {
  hostQueryKey,
  type HostQueryKey,
  type HostQueryParams,
  type HostQueryTarget
} from './host-query-key'
import { holdsRestoredHostQueryData, type HostQueryPersist } from './host-query-persistence'
import { hostReadClient } from './host-read-client'

// Exported with the query hooks so the router lands in their page chunk, not a chunk of its own.
export { useHostEventRouter } from './host-event-router'

export type HostQuery<TInput extends HostQueryParams, TData> = {
  family: string
  // Calls the domain's loader. `previous` is the cached data a revalidation may build on; live reads pass none.
  // Absent for a family only its screen can read (its inputs live in the screen); that screen passes `read`.
  fetch?: HostQueryFetch<TInput, TData>
  staleTime?: StaleTimeFunction<TData, Error, TData, HostQueryKey>
  gcTime?: number
  // Only for families the desktop sends no change signal for.
  refetchOnWindowFocus?: boolean
  // For a screen that offers its own Retry, so a lost read is reported instead of sent again.
  retry?: false
  // Kept fresh by a subscription, so the connected edge leaves it alone.
  streamBacked?: boolean
  // Desktop change events that make this family stale (host-event-router), and the least time between reads they cause.
  signal?: HostQuerySignal
  // Kept on the phone between launches (host-query-persistence); absent means memory only.
  persist?: HostQueryPersist<TData>
}

export type HostQuerySignal = {
  events: readonly Exclude<RuntimeClientEventStreamMessage['type'], 'ready' | 'end'>[]
  floorMs?: number
}

type HostQueryFetch<TInput extends HostQueryParams, TData> = (
  client: RpcClient,
  target: HostQueryTarget,
  input: TInput,
  previous: TData | undefined,
  read: HostQueryRead
) => Promise<TData>

// `live` marks an action's read (readHostQueryLive), which must not be served from a host-side cache.
// `previousFromStore` says `previous` is an earlier launch's copy that no read in this document confirmed.
export type HostQueryRead = { live: boolean; previousFromStore: boolean }

export function defineHostQuery<TInput extends HostQueryParams, TData>(
  query: HostQuery<TInput, TData> & { fetch: HostQueryFetch<TInput, TData> }
): HostQuery<TInput, TData> & { fetch: HostQueryFetch<TInput, TData> }
export function defineHostQuery<TInput extends HostQueryParams, TData>(
  query: HostQuery<TInput, TData>
): HostQuery<TInput, TData>
export function defineHostQuery<TInput extends HostQueryParams, TData>(
  query: HostQuery<TInput, TData>
): HostQuery<TInput, TData> {
  return query
}

function hostQueryOptions<TInput extends HostQueryParams, TData>(
  query: HostQuery<TInput, TData>,
  client: RpcClient,
  hostId: string,
  target: HostQueryTarget,
  input: TInput
) {
  const { family, fetch, streamBacked, signal, persist, ...freshness } = query
  const queryKey = hostQueryKey(hostId, family, target, input)
  return queryOptions({
    ...freshness,
    queryKey,
    // No abort signal: the host has no cancel, and a screen that unmounts still wants the answer cached.
    queryFn: fetch
      ? ({ client: queryClient }) =>
          fetch(hostReadClient(client), target, input, queryClient.getQueryData<TData>(queryKey), {
            live: false,
            previousFromStore: holdsRestoredHostQueryData(queryClient, hashKey(queryKey))
          })
      : skipToken,
    meta: { streamBacked, signal, persist }
  })
}

// An action's read: no stale copy and nothing built on the cached data; resolves once observers hold the answer.
// `replace` cancels a read already out (its caller rejects rather than resolving with old data) instead of joining it.
// `read` stands in for the family's fetch when the screen holds the inputs; it may stop early once `signal` aborts.
export async function readHostQueryLive<TInput extends HostQueryParams, TData>(
  queryClient: QueryClient,
  query: HostQuery<TInput, TData>,
  host: { hostId: string; client: RpcClient },
  target: HostQueryTarget,
  input: TInput,
  options: { replace: boolean; read?: (signal: AbortSignal) => Promise<TData> }
): Promise<TData> {
  const { hostId, client } = host
  if (options.replace) {
    const queryKey = hostQueryKey(hostId, query.family, target, input)
    await queryClient.cancelQueries({ queryKey, exact: true }, { silent: true })
  }
  const { fetch } = query
  const { read } = options
  const live =
    fetch &&
    (() =>
      fetch(hostReadClient(client), target, input, undefined, {
        live: true,
        previousFromStore: false
      }))
  if (!read && !live) {
    throw new Error(`${query.family} is read by its screen`)
  }
  const data = await queryClient.query({
    ...hostQueryOptions(query, client, hostId, target, input),
    // Only a call-site reader takes the signal: taking it lets TanStack cancel the read once no screen observes it.
    queryFn: read ? ({ signal }) => read(signal) : live,
    staleTime: 0
  })
  await new Promise<void>((resolve) => notifyManager.schedule(resolve))
  return data
}

// A read ahead of the user: skipped while the key holds current data, joins a read already out.
export function prefetchHostQuery<TInput extends HostQueryParams, TData>(
  queryClient: QueryClient,
  query: HostQuery<TInput, TData>,
  host: { hostId: string; client: RpcClient },
  target: HostQueryTarget,
  input: TInput
): Promise<void> {
  return queryClient.prefetchQuery({
    ...hostQueryOptions(query, host.client, host.hostId, target, input),
    staleTime: Infinity
  })
}

// Without a client the observer still reads the cached entry, but never fetches.
function observerOptions<TInput extends HostQueryParams, TData>(
  query: HostQuery<TInput, TData>,
  client: RpcClient | null,
  hostId: string,
  target: HostQueryTarget,
  input: TInput
): UseQueryOptions<TData, Error, TData, HostQueryKey> {
  return client
    ? hostQueryOptions(query, client, hostId, target, input)
    : {
        queryKey: hostQueryKey(hostId, query.family, target, input),
        queryFn: skipToken,
        meta: { streamBacked: query.streamBacked, signal: query.signal, persist: query.persist }
      }
}

export function useHostQuery<TInput extends HostQueryParams, TData>(
  query: HostQuery<TInput, TData>,
  host: { hostId: string; client: RpcClient | null },
  target: HostQueryTarget,
  input: TInput,
  options?: { enabled?: boolean; subscribed?: boolean; refetchInterval?: number | false }
): UseQueryResult<TData> {
  const { hostId, client } = host
  const enabled = client !== null && options?.enabled !== false
  useHostConnectionInvalidation(hostId, enabled ? client : null)
  // Same options object while nothing changed (target and input count by value), so TanStack's per-render setOptions is a no-op.
  const keyHash = hashKey([target, input])
  const queryOptions = useMemo((): UseQueryOptions<TData, Error, TData, HostQueryKey> => {
    const observer = observerOptions(query, client, hostId, target, input)
    // Disable through the observer, not skipToken: observers share the query's options, so a disabled
    // screen's skipToken would leave an enabled one's key with no fetch for invalidation or intervals.
    return enabled ? observer : { ...observer, enabled: false }
  }, [query, client, hostId, keyHash, enabled])
  return useQuery({
    ...queryOptions,
    subscribed: options?.subscribed,
    refetchInterval: options?.refetchInterval
  })
}

// One query per input (e.g. one per open folder), combined into one value; keep `combine` stable so the value is memoized.
export function useHostQueries<TInput extends HostQueryParams, TData, TCombined>(
  query: HostQuery<TInput, TData>,
  host: { hostId: string; client: RpcClient | null },
  target: HostQueryTarget,
  inputs: readonly TInput[],
  combine: (results: UseQueryResult<TData>[]) => TCombined
): TCombined {
  const { hostId, client } = host
  useHostConnectionInvalidation(hostId, client)
  const keyHash = hashKey([target, inputs])
  const queries = useMemo(
    () => inputs.map((input) => observerOptions(query, client, hostId, target, input)),
    [query, client, hostId, keyHash]
  )
  return useQueries({ queries, combine })
}
