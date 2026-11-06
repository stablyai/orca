import { queryOptions, skipToken, useQuery, type UseQueryResult } from '@tanstack/react-query'
import type { RpcClient } from '../transport/rpc-client'
import { useHostConnectionInvalidation } from './host-connection-invalidation'
import { hostQueryKey, type HostQueryParams, type HostQueryTarget } from './host-query-key'
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

// For reads outside React: queryClient.query(hostQueryOptions(...)).
export function hostQueryOptions<TInput extends HostQueryParams, TData>(
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

// Actions read live: no stale copy and nothing built on the cached data.
export function hostQueryLiveOptions<TInput extends HostQueryParams, TData>(
  query: HostQuery<TInput, TData>,
  client: RpcClient,
  hostId: string,
  target: HostQueryTarget,
  input: TInput
) {
  return {
    ...hostQueryOptions(query, client, hostId, target, input),
    queryFn: () => query.fetch(hostReadClient(client), target, input, undefined),
    staleTime: 0
  }
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
  return useQuery({
    ...(client
      ? hostQueryOptions(query, client, hostId, target, input)
      : { queryKey: hostQueryKey(hostId, query.family, target, input) }),
    ...(!enabled && { queryFn: skipToken }),
    subscribed: options?.subscribed
  })
}
