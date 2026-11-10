import { QueryClient } from '@tanstack/react-query'
import { hostQueryRetryDelay, shouldRetryHostQuery } from './host-query-errors'

// One per JS world (the native heap, each page document); families override the freshness defaults.
export function createOrcaQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Connectivity is per host; onlineManager is one global boolean.
        networkMode: 'always',
        refetchOnWindowFocus: false,
        // Each host's connected edge refetches instead (host-connection-invalidation).
        refetchOnReconnect: false,
        staleTime: 30_000,
        gcTime: 10 * 60_000,
        retry: shouldRetryHostQuery,
        retryDelay: hostQueryRetryDelay
      },
      mutations: { networkMode: 'always', retry: 0 }
    }
  })
}
