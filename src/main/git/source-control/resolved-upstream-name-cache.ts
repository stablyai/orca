// Why: cache the upstream name to skip its 4-5-spawn resolution chain each poll; revalidate via one rev-list (issue #7576).
export const RESOLVED_UPSTREAM_NAME_CACHE_TTL_MS = 60_000

type ResolvedUpstreamNameCacheEntry = {
  upstreamName: string
  expiresAt: number
}

export const resolvedUpstreamNameCache = new Map<string, ResolvedUpstreamNameCacheEntry>()
