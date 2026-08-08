import type { AiVaultListResult } from '../../shared/ai-vault-types'
import {
  aiVaultSessionDepthCovers,
  truncateAiVaultListResult,
  type AiVaultSessionDepth
} from '../../shared/ai-vault-session-depth'

export const AI_VAULT_CACHE_TTL_MS = 15_000

type CachedHostLeg = {
  depth: AiVaultSessionDepth
  result: AiVaultListResult
  expiresAt: number
}

// Why: the merged result is only cacheable when every host answered, so one
// flaky host used to force a full rescan of every healthy host on each panel
// open. Legs are cached individually and the failing host is the only one
// rescanned.
const cachedHostLegs = new Map<string, CachedHostLeg>()
// Bumped on every invalidation. A leg scan that started before an invalidation
// carries the old generation and must not write its (now stale) result back —
// otherwise a delete's invalidation is silently undone by a scan that resolves
// just after it.
let cacheGeneration = 0

/** Serves one host's leg from the per-host TTL cache, and stores it only when
 * that host answered without a host issue — a failing host is retried on the
 * next open while its healthy neighbours stay cached. */
export async function scanHostLegWithCache(args: {
  cacheKey: string
  depth: AiVaultSessionDepth
  scopePaths?: readonly string[]
  force: boolean
  scan: () => Promise<AiVaultListResult>
}): Promise<AiVaultListResult> {
  const now = Date.now()
  const startGeneration = cacheGeneration
  const cached = cachedHostLegs.get(args.cacheKey)
  if (
    !args.force &&
    cached &&
    cached.expiresAt > now &&
    aiVaultSessionDepthCovers(cached.depth, args.depth)
  ) {
    return truncateAiVaultListResult(cached.result, args.depth, args.scopePaths)
  }
  const result = await args.scan()
  // A delete's invalidation landed while this leg was scanning; caching a
  // pre-delete result would resurrect the deleted session for the TTL.
  if (startGeneration !== cacheGeneration) {
    return result
  }
  if (result.issues.some((issue) => issue.kind === 'host')) {
    const current = cachedHostLegs.get(args.cacheKey)
    if (!current || current.expiresAt <= Date.now()) {
      cachedHostLegs.delete(args.cacheKey)
    }
    return result
  }
  pruneExpiredHostLegs(now)
  const current = cachedHostLegs.get(args.cacheKey)
  if (
    !args.force &&
    current &&
    current.expiresAt > Date.now() &&
    aiVaultSessionDepthCovers(current.depth, args.depth)
  ) {
    return result
  }
  cachedHostLegs.set(args.cacheKey, {
    depth: args.depth,
    result,
    expiresAt: Date.now() + AI_VAULT_CACHE_TTL_MS
  })
  return result
}

function pruneExpiredHostLegs(now: number): void {
  for (const [cacheKey, entry] of cachedHostLegs) {
    if (entry.expiresAt <= now) {
      cachedHostLegs.delete(cacheKey)
    }
  }
}

// Drops every cached host leg after a session is deleted so a non-force list
// call within the TTL can't still serve the trashed session. Scan discovery
// walks disk first, so a deleted file is never rediscovered — this only guards
// the cached RESULT.
export function invalidateAiVaultHostLegCache(): void {
  cacheGeneration++
  cachedHostLegs.clear()
}

export function resetAiVaultHostLegCacheForTests(): void {
  invalidateAiVaultHostLegCache()
}
