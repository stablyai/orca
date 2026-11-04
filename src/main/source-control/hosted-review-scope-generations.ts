import type { ExecutionHostId } from '../../shared/execution-host'
import { MAX_BRANCH_MAP_ENTRIES } from './hosted-review-refresh-pacing'

/** Fence lookups begun before review creation so they cannot reinstall stale absence (#11532). */
const scopeGenerations = new Map<string, number>()

/** Eviction must never read back as the original zero generation. A monotonic floor may discard fresh data but cannot admit stale data. */
let evictedGeneration = 0

// Cache invalidation and provider reads must use the same host-scoped identity.
export function hostedReviewRepoScope(repoPath: string, executionHostId: ExecutionHostId): string {
  return `${executionHostId}\0${repoPath}`
}

export function scopeGeneration(scope: string): number {
  return scopeGenerations.get(scope) ?? evictedGeneration
}

export function bumpScopeGeneration(scope: string): void {
  const next = scopeGeneration(scope) + 1
  scopeGenerations.delete(scope)
  scopeGenerations.set(scope, next)
  while (scopeGenerations.size > MAX_BRANCH_MAP_ENTRIES) {
    const oldest = scopeGenerations.keys().next().value
    if (oldest === undefined) {
      break
    }
    evictedGeneration = Math.max(evictedGeneration, scopeGenerations.get(oldest) ?? 0)
    scopeGenerations.delete(oldest)
  }
}

/** @internal - exposed for tests only */
export function __resetHostedReviewScopeGenerationsForTests(): void {
  scopeGenerations.clear()
  evictedGeneration = 0
}
