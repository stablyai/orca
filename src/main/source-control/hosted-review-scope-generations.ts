import { MAX_BRANCH_MAP_ENTRIES } from './hosted-review-refresh-pacing'

/**
 * Per-repo invalidation counter for hosted-review lookups (#11532).
 *
 * A lookup that was already out when Orca opened a review has an answer older
 * than the invalidation, so it must not store. Comparing the generation it
 * started at against the current one is what tells the two apart.
 */
const scopeGenerations = new Map<string, number>()

/**
 * Floor for a scope the size cap dropped. Without it an eviction reads back as
 * generation 0 — the same value a lookup that started before the first
 * invalidation captured — and that lookup's pre-invalidation answer would be
 * stored as current. Never decreasing is what keeps the comparison one-way:
 * eviction can only make a lookup discard its result, never adopt a stale one.
 */
let evictedGeneration = 0

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
