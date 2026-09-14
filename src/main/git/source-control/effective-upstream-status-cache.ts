import type { GitUpstreamStatus } from '../../../shared/git-status-types'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { invalidateGitReadCaches } from './git-read-cache-invalidation'
import { resolvedUpstreamNameCache } from './resolved-upstream-name-cache'

const EFFECTIVE_UPSTREAM_NEGATIVE_CACHE_TTL_MS = 5 * 60_000
export const MAX_EFFECTIVE_UPSTREAM_NEGATIVE_CACHE_ENTRIES = 512

type EffectiveUpstreamStatusCacheEntry = {
  expiresAt: number
  status: GitUpstreamStatus
}

const effectiveUpstreamStatusCache = new Map<string, EffectiveUpstreamStatusCacheEntry>()
export const effectiveUpstreamStatusInFlight = new Map<string, Promise<GitUpstreamStatus>>()
const retiredEffectiveUpstreamStatusInFlight = new Map<string, Promise<GitUpstreamStatus>>()

export const effectiveUpstreamStatusWriteGeneration = new Map<string, number>()

// Why: tests reuse this hook, so every memoization layer resets together despite the upstream-only name.
export function clearEffectiveUpstreamStatusCacheForTests(): void {
  effectiveUpstreamStatusCache.clear()
  effectiveUpstreamStatusInFlight.clear()
  retiredEffectiveUpstreamStatusInFlight.clear()
  effectiveUpstreamStatusWriteGeneration.clear()
  invalidateGitReadCaches()
}

export function getEffectiveUpstreamStatusCacheCountForTests(): number {
  return effectiveUpstreamStatusCache.size
}

export function getEffectiveUpstreamStatusGenerationCountForTests(): number {
  return effectiveUpstreamStatusWriteGeneration.size
}

export function getEffectiveUpstreamStatusCacheKey(
  worktreePath: string,
  branchName: string,
  upstreamName: string | undefined,
  options: GitRuntimeOptions = {}
): string {
  return [worktreePath, options.wslDistro ?? 'host', branchName, upstreamName ?? ''].join('\0')
}

export function clearEffectiveUpstreamNegativeStatusCache(identity: {
  worktreePath: string
  branchName: string
  upstreamName?: string
  options?: GitRuntimeOptions
}): void {
  const cacheKey = getEffectiveUpstreamStatusCacheKey(
    identity.worktreePath,
    identity.branchName,
    identity.upstreamName,
    identity.options
  )
  retireEffectiveUpstreamStatusProbe(cacheKey)
  effectiveUpstreamStatusCache.delete(cacheKey)
  effectiveUpstreamStatusInFlight.delete(cacheKey)
  resolvedUpstreamNameCache.delete(cacheKey)
  effectiveUpstreamStatusWriteGeneration.set(
    cacheKey,
    (effectiveUpstreamStatusWriteGeneration.get(cacheKey) ?? 0) + 1
  )
}

function retireEffectiveUpstreamStatusProbe(cacheKey: string): void {
  const retiredProbe = effectiveUpstreamStatusInFlight.get(cacheKey)
  if (!retiredProbe) {
    return
  }
  retiredEffectiveUpstreamStatusInFlight.set(cacheKey, retiredProbe)
  void retiredProbe
    .finally(() => {
      if (retiredEffectiveUpstreamStatusInFlight.get(cacheKey) === retiredProbe) {
        retiredEffectiveUpstreamStatusInFlight.delete(cacheKey)
        trimEffectiveUpstreamStatusGeneration()
      }
    })
    .catch(() => undefined)
}

function hasPendingEffectiveUpstreamStatusProbe(cacheKey: string): boolean {
  return (
    effectiveUpstreamStatusInFlight.has(cacheKey) ||
    retiredEffectiveUpstreamStatusInFlight.has(cacheKey)
  )
}

export function trimEffectiveUpstreamStatusGeneration(): void {
  for (const cacheKey of effectiveUpstreamStatusWriteGeneration.keys()) {
    if (
      effectiveUpstreamStatusWriteGeneration.size <= MAX_EFFECTIVE_UPSTREAM_NEGATIVE_CACHE_ENTRIES
    ) {
      break
    }
    if (hasPendingEffectiveUpstreamStatusProbe(cacheKey)) {
      continue
    }
    effectiveUpstreamStatusWriteGeneration.delete(cacheKey)
  }
}

export function readCachedEffectiveUpstreamStatus(
  cacheKey: string,
  now: number
): GitUpstreamStatus | undefined {
  const entry = effectiveUpstreamStatusCache.get(cacheKey)
  if (!entry) {
    return undefined
  }
  if (entry.expiresAt <= now) {
    effectiveUpstreamStatusCache.delete(cacheKey)
    return undefined
  }
  return entry.status
}

export function rememberEffectiveUpstreamStatus(
  cacheKey: string,
  status: GitUpstreamStatus,
  now: number,
  probedSameNameOriginRef: boolean,
  writeGeneration: number
): void {
  // Why: hasConfiguredPushTarget gates a write action; re-probe each poll rather than cache a stale positive.
  if (status.hasUpstream || status.hasConfiguredPushTarget) {
    effectiveUpstreamStatusCache.delete(cacheKey)
    effectiveUpstreamStatusWriteGeneration.set(cacheKey, writeGeneration + 1)
    trimEffectiveUpstreamStatusGeneration()
    return
  }
  if ((effectiveUpstreamStatusWriteGeneration.get(cacheKey) ?? 0) !== writeGeneration) {
    return
  }
  if (!probedSameNameOriginRef) {
    return
  }
  // Why: cache the negative so a stable no-upstream branch doesn't re-probe every poll (TTL lets push/fetch refs appear).
  effectiveUpstreamStatusCache.set(cacheKey, {
    status,
    expiresAt: now + EFFECTIVE_UPSTREAM_NEGATIVE_CACHE_TTL_MS
  })
  while (effectiveUpstreamStatusCache.size > MAX_EFFECTIVE_UPSTREAM_NEGATIVE_CACHE_ENTRIES) {
    const oldest = effectiveUpstreamStatusCache.keys().next()
    if (oldest.done) {
      break
    }
    effectiveUpstreamStatusCache.delete(oldest.value)
    effectiveUpstreamStatusWriteGeneration.delete(oldest.value)
  }
  trimEffectiveUpstreamStatusGeneration()
}
