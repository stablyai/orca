import { useEffect } from 'react'
import { useQueryClient, type Query, type QueryClient } from '@tanstack/react-query'
import { createHostConnectRefetchGate } from '../transport/host-connect-refetch-gate'
import type { RpcClient } from '../transport/rpc-client'
import { hostScopeKey } from './host-query-key'

type Watch = { holders: number; stop: () => void }

const watches = new WeakMap<QueryClient, Map<RpcClient, Watch>>()

// A live stream rewrites its own cache entry after the registry replays it.
function refetchesOnConnect(query: Query): boolean {
  return query.meta?.streamBacked !== true
}

// One connected-edge listener per world per host client, however many screens read that host.
function retainHostConnectionInvalidation(
  queryClient: QueryClient,
  hostId: string,
  client: RpcClient
): () => void {
  let byClient = watches.get(queryClient)
  if (!byClient) {
    byClient = new Map()
    watches.set(queryClient, byClient)
  }
  let watch = byClient.get(client)
  if (!watch) {
    const gate = createHostConnectRefetchGate()
    gate.observe(client.getState())
    const stop = client.onStateChange((state) => {
      if (gate.observe(state)) {
        // Marks the host's queries stale and refetches only the observed ones; joins reads already in flight.
        void queryClient.invalidateQueries(
          { queryKey: hostScopeKey(hostId), predicate: refetchesOnConnect },
          { cancelRefetch: false }
        )
      }
    })
    watch = { holders: 0, stop }
    byClient.set(client, watch)
  }
  const held = watch
  held.holders += 1
  return () => {
    held.holders -= 1
    if (held.holders === 0) {
      held.stop()
      byClient.delete(client)
    }
  }
}

export function useHostConnectionInvalidation(hostId: string, client: RpcClient | null): void {
  const queryClient = useQueryClient()
  useEffect(
    () => (client ? retainHostConnectionInvalidation(queryClient, hostId, client) : undefined),
    [queryClient, hostId, client]
  )
}
