import { useMemo } from 'react'
import {
  hashKey,
  notifyManager,
  queryOptions,
  skipToken,
  useQueries,
  useQuery,
  type QueryClient,
  type UseQueryOptions,
  type UseQueryResult
} from '@tanstack/react-query'
import type { RpcClient } from '../transport/rpc-client'
import { useHostConnectionInvalidation } from './host-connection-invalidation'
import {
  hostQueryKey,
  type HostQueryKey,
  type HostQueryParams,
  type HostQueryTarget
} from './host-query-key'
import { hostReadClient } from './host-read-client'

export type HostQuery<TInput extends HostQueryParams, TData> = {
  family: string
  // Calls the domain's loader. `previous` is the cached data a revalidation may build on; live reads pass none.
  fetch: (
    client: RpcClient,
    target: HostQueryTarget,
    input: TInput,
    previous: TData | undefined
  ) => Promise<TData>
  staleTime?: number
  gcTime?: number
  // Only for families the desktop sends no change signal for.
  refetchOnWindowFocus?: boolean
  // Kept fresh by a subscription, so the connected edge leaves it alone.
  streamBacked?: boolean
}

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
  const { family, fetch, streamBacked, ...freshness } = query
  const queryKey = hostQueryKey(hostId, family, target, input)
  return queryOptions({
    ...freshness,
    queryKey,
    // No abort signal: the host has no cancel, and a screen that unmounts still wants the answer cached.
    queryFn: ({ client: queryClient }) =>
      fetch(hostReadClient(client), target, input, queryClient.getQueryData<TData>(queryKey)),
    meta: { streamBacked }
  })
}

// An action's read: no stale copy and nothing built on the cached data; resolves once observers hold the answer.
// `replace` cancels a read already out (its caller rejects rather than resolving with old data) instead of joining it.
export async function readHostQueryLive<TInput extends HostQueryParams, TData>(
  queryClient: QueryClient,
  query: HostQuery<TInput, TData>,
  host: { hostId: string; client: RpcClient },
  target: HostQueryTarget,
  input: TInput,
  options: { replace: boolean }
): Promise<TData> {
  const { hostId, client } = host
  if (options.replace) {
    const queryKey = hostQueryKey(hostId, query.family, target, input)
    await queryClient.cancelQueries({ queryKey, exact: true }, { silent: true })
  }
  const data = await queryClient.query({
    ...hostQueryOptions(query, client, hostId, target, input),
    queryFn: () => query.fetch(hostReadClient(client), target, input, undefined),
    staleTime: 0
  })
  await new Promise<void>((resolve) => notifyManager.schedule(resolve))
  return data
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
    : { queryKey: hostQueryKey(hostId, query.family, target, input), queryFn: skipToken }
}

export function useHostQuery<TInput extends HostQueryParams, TData>(
  query: HostQuery<TInput, TData>,
  host: { hostId: string; client: RpcClient | null },
  target: HostQueryTarget,
  input: TInput,
  options?: { enabled?: boolean; subscribed?: boolean }
): UseQueryResult<TData> {
  const { hostId, client } = host
  const enabled = client !== null && options?.enabled !== false
  useHostConnectionInvalidation(hostId, enabled ? client : null)
  // Same options object while nothing changed (target and input count by value), so TanStack's per-render setOptions is a no-op.
  const keyHash = hashKey([target, input])
  const queryOptions = useMemo((): UseQueryOptions<TData, Error, TData, HostQueryKey> => {
    const observer = observerOptions(query, client, hostId, target, input)
    return enabled ? observer : { ...observer, queryFn: skipToken }
  }, [query, client, hostId, keyHash, enabled])
  return useQuery({ ...queryOptions, subscribed: options?.subscribed })
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
