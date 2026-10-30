// Cache the name to replace repeated resolution chains with one rev-list revalidation per poll.
export const RESOLVED_UPSTREAM_NAME_CACHE_TTL_MS = 60_000

type ResolvedUpstreamNameCacheEntry = {
  upstreamName: string
  expiresAt: number
}

export const resolvedUpstreamNameCache = new Map<string, ResolvedUpstreamNameCacheEntry>()
