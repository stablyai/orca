import type { AiVaultProjectionDependency } from './ai-vault-projection-dependency'
import { MAX_TIMER_DELAY_MS } from '../../shared/timer-delay'
import type { AiVaultListResult } from '../../shared/ai-vault-types'
import {
  aiVaultCachedDepthServes,
  truncateAiVaultListResult,
  type AiVaultSessionDepth
} from '../../shared/ai-vault-session-depth'

export const AI_VAULT_CACHE_TTL_MS = 15_000

type CachedHostLeg = {
  dependency?: AiVaultProjectionDependency
  release?: () => void
  depth: AiVaultSessionDepth
  result: AiVaultListResult
  expiresAt: number
}

// Cache healthy legs independently so one failing host cannot force every host to rescan.
const cachedHostLegs = new Map<string, CachedHostLeg>()
// Fence scans begun before invalidation so late results cannot resurrect deleted sessions.
let cacheGeneration = 0
// Retain rows behind unchanged replies for readers without fingerprints.
const lastFullHostLegs = new Map<
  string,
  {
    depth: AiVaultSessionDepth
    result: AiVaultListResult
    dependency?: AiVaultProjectionDependency
    release?: () => void
  }
>()
const LAST_FULL_HOST_LEGS_MAX = 8
let expiryTimer: ReturnType<typeof setTimeout> | null = null

function scheduleHostLegExpiry(): void {
  if (expiryTimer !== null || cachedHostLegs.size === 0) {
    return
  }
  let earliest = Infinity
  for (const entry of cachedHostLegs.values()) {
    earliest = Math.min(earliest, entry.expiresAt)
  }
  expiryTimer = setTimeout(
    () => {
      expiryTimer = null
      pruneExpiredHostLegs(Date.now())
      scheduleHostLegExpiry()
    },
    Math.min(MAX_TIMER_DELAY_MS, Math.max(0, earliest - Date.now()))
  )
  expiryTimer.unref?.()
}

/** Serves one host's leg from the per-host TTL cache, and stores it only when
 * that host answered without a host issue — a failing host is retried on the
 * next open while its healthy neighbours stay cached. */
export async function scanHostLegWithCache(args: {
  cacheKey: string
  dependency?: AiVaultProjectionDependency
  depth: AiVaultSessionDepth
  scopePaths?: readonly string[]
  force: boolean
  afterFingerprint?: string | null
  scan: () => Promise<AiVaultListResult>
}): Promise<AiVaultListResult> {
  const now = Date.now()
  const startGeneration = cacheGeneration
  const cached = cachedHostLegs.get(args.cacheKey)
  if (
    !args.force &&
    cached &&
    cached.dependency?.key === args.dependency?.key &&
    (cached.dependency?.isCurrent() ?? true) &&
    cached.expiresAt > now &&
    aiVaultCachedDepthServes(cached.depth, args.depth, args.scopePaths) &&
    (!cached.result.unchanged ||
      (cached.depth === args.depth && cached.result.fingerprint === args.afterFingerprint))
  ) {
    return truncateAiVaultListResult(cached.result, args.depth, args.scopePaths)
  }
  const result = await args.scan()
  // A delete's invalidation landed while this leg was scanning; caching a
  // pre-delete result would resurrect the deleted session for the TTL.
  if (startGeneration !== cacheGeneration || args.dependency?.isCurrent() === false) {
    return result
  }
  if (result.issues.some((issue) => issue.kind === 'host')) {
    const current = cachedHostLegs.get(args.cacheKey)
    if (!current || current.expiresAt <= Date.now()) {
      dropEntry(cachedHostLegs, args.cacheKey)
    }
    return result
  }
  pruneExpiredHostLegs(now)
  const current = cachedHostLegs.get(args.cacheKey)
  if (
    !args.force &&
    current &&
    current.dependency?.key === args.dependency?.key &&
    (current.dependency?.isCurrent() ?? true) &&
    current.expiresAt > Date.now() &&
    aiVaultCachedDepthServes(current.depth, args.depth, args.scopePaths) &&
    (!current.result.unchanged ||
      (current.depth === args.depth && current.result.fingerprint === args.afterFingerprint))
  ) {
    return result
  }
  dropEntry(cachedHostLegs, args.cacheKey)
  cachedHostLegs.set(args.cacheKey, {
    dependency: args.dependency,
    release: args.dependency?.retain(),
    depth: args.depth,
    result: rememberFullHostLeg(args.cacheKey, args.depth, result, args.dependency),
    expiresAt: Date.now() + AI_VAULT_CACHE_TTL_MS
  })
  scheduleHostLegExpiry()
  return result
}

/** Returns the full list an `unchanged` reply stands for when one is known. */
function rememberFullHostLeg(
  cacheKey: string,
  depth: AiVaultSessionDepth,
  result: AiVaultListResult,
  dependency?: AiVaultProjectionDependency
): AiVaultListResult {
  if (!result.fingerprint) {
    return result
  }
  const previous = lastFullHostLegs.get(cacheKey)
  if (result.unchanged) {
    return previous?.depth === depth &&
      previous.dependency?.key === dependency?.key &&
      (previous.dependency?.isCurrent() ?? true) &&
      previous.result.fingerprint === result.fingerprint
      ? { ...previous.result, scannedAt: result.scannedAt }
      : result
  }
  dropEntry(lastFullHostLegs, cacheKey)
  lastFullHostLegs.set(cacheKey, { depth, result, dependency, release: dependency?.retain() })
  for (const oldest of lastFullHostLegs.keys()) {
    if (lastFullHostLegs.size <= LAST_FULL_HOST_LEGS_MAX) {
      break
    }
    dropEntry(lastFullHostLegs, oldest)
  }
  return result
}

function pruneExpiredHostLegs(now: number): void {
  for (const [cacheKey, entry] of cachedHostLegs) {
    if (entry.expiresAt <= now) {
      dropEntry(cachedHostLegs, cacheKey)
    }
  }
}

// Drops every cached host leg after a session is deleted so a non-force list
// call within the TTL can't still serve the trashed session. Scan discovery
// walks disk first, so a deleted file is never rediscovered — this only guards
// the cached RESULT.
function dropEntry<T extends { release?: () => void }>(entries: Map<string, T>, key: string): void {
  entries.get(key)?.release?.()
  entries.delete(key)
}

export function invalidateAiVaultHostLegCache(environmentId?: string): void {
  if (environmentId === undefined) {
    cacheGeneration++
  }
  for (const entries of [cachedHostLegs, lastFullHostLegs]) {
    for (const [key, entry] of entries) {
      if (environmentId === undefined || entry.dependency?.hosts.includes(environmentId)) {
        dropEntry(entries, key)
      }
    }
  }
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer)
  }
  expiryTimer = null
  scheduleHostLegExpiry()
}

export function resetAiVaultHostLegCacheForTests(): void {
  invalidateAiVaultHostLegCache()
}
