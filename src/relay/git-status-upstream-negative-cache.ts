import type { GitUpstreamStatus } from '../shared/types'

const NO_EFFECTIVE_UPSTREAM_CACHE_TTL_MS = 5 * 60_000

type NoEffectiveUpstreamCacheIdentity = {
  worktreePath: string
  branch?: string
  head?: string
}

type NoEffectiveUpstreamCacheEntry = {
  status: GitUpstreamStatus
  expiresAt: number
}

const noEffectiveUpstreamByIdentity = new Map<string, NoEffectiveUpstreamCacheEntry>()

function noEffectiveUpstreamCacheKey(identity: NoEffectiveUpstreamCacheIdentity): string {
  return [identity.worktreePath, identity.branch ?? '', identity.head ?? ''].join('\0')
}

export function readCachedNoEffectiveUpstreamStatus(
  identity: NoEffectiveUpstreamCacheIdentity,
  nowMs = Date.now()
): GitUpstreamStatus | null {
  const key = noEffectiveUpstreamCacheKey(identity)
  const entry = noEffectiveUpstreamByIdentity.get(key)
  if (!entry) {
    return null
  }
  if (entry.expiresAt <= nowMs) {
    noEffectiveUpstreamByIdentity.delete(key)
    return null
  }
  return entry.status
}

export function cacheNoEffectiveUpstreamStatus(
  identity: NoEffectiveUpstreamCacheIdentity,
  status: GitUpstreamStatus,
  nowMs = Date.now()
): void {
  if (status.hasUpstream) {
    return
  }
  noEffectiveUpstreamByIdentity.set(noEffectiveUpstreamCacheKey(identity), {
    status,
    expiresAt: nowMs + NO_EFFECTIVE_UPSTREAM_CACHE_TTL_MS
  })
}

export function clearNoEffectiveUpstreamStatusCache(): void {
  noEffectiveUpstreamByIdentity.clear()
}
