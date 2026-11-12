/**
 * DISPOSABLE EXPERIMENT (STA-8667 D3). PROTOTYPE of the proposed per-resource rate-limit state
 * (design §4.5, finding D2-4). It models the rule only; it is not production code and it does
 * not parse real headers. Three policies share one interface so the probe can compare them:
 *
 *   today  whole snapshot from `gh api rate_limit`, re-probed when older than 30 s
 *   d2     header-fed; a probe only when the scope has no state at all (the D2 text)
 *   d3     header-fed; per resource: an unknown or expired resource that is about to be spent
 *          by a HEADERLESS background read triggers one scoped, coalesced refresh, at most one
 *          attempt per scope per 60 s; failure fails open (as today)
 */
export type Resource = 'core' | 'graphql' | 'search'
export type Budget = { limit: number; remaining: number; resetAt: number }
type Entry = Budget & { observedAt: number }
export type ProbeResult = { ok: true; resources: Record<Resource, Budget> } | { ok: false }

const FLOOR: Record<Resource, number> = { core: 50, graphql: 50, search: 2 }
export const REFRESH_MIN_GAP_MS = 60_000
const SAME_WINDOW_S = 5

export function createRateLimitState(policy: 'today' | 'd2' | 'd3', now: () => number, probe: () => ProbeResult) {
  // One instance = one scope (runtime + API host + executing account).
  const state = new Map<Resource, Entry>()
  let snapshotAt = -Infinity
  let lastRefreshAttemptAt = -Infinity
  let credentialEpoch = 0
  const stats = { probes: 0, probeFailures: 0, blocked: 0, admitted: 0, staleResponsesIgnored: 0 }

  const fresh = (r: Resource): Entry | null => {
    const e = state.get(r)
    return e && e.limit > 0 && e.resetAt * 1000 > now() ? e : null
  }
  /** Ordering rule for any observation (header or probe). */
  const observe = (r: Resource, b: Budget, epochAtStart = credentialEpoch): void => {
    if (epochAtStart !== credentialEpoch) {
      stats.staleResponsesIgnored += 1
      return
    }
    const cur = state.get(r)
    if (cur && cur.limit > 0) {
      if (b.resetAt < cur.resetAt - SAME_WINDOW_S) {
        stats.staleResponsesIgnored += 1 // a response from an older window
        return
      }
      if (Math.abs(b.resetAt - cur.resetAt) <= SAME_WINDOW_S) {
        state.set(r, { ...cur, remaining: Math.min(cur.remaining, b.remaining), observedAt: now() })
        return
      }
    }
    state.set(r, { ...b, observedAt: now() })
  }
  const runProbe = (): void => {
    stats.probes += 1
    lastRefreshAttemptAt = now()
    const epoch = credentialEpoch
    const result = probe()
    if (!result.ok) {
      stats.probeFailures += 1
      return
    }
    snapshotAt = now()
    for (const r of ['core', 'graphql', 'search'] as Resource[]) observe(r, result.resources[r], epoch)
  }
  const guard = (r: Resource): boolean => {
    const e = fresh(r)
    return e !== null && e.remaining < FLOOR[r]
  }

  return {
    stats,
    state,
    /** A background read that returns NO rate-limit headers (`gh pr view`, `gh pr list`). */
    headerlessBackgroundRead(r: Resource): 'admitted' | 'blocked' {
      if (policy === 'today') {
        if (now() - snapshotAt >= 30_000) runProbe()
      } else if (policy === 'd2') {
        if (state.size === 0) runProbe()
      } else if (fresh(r) === null) {
        // Expired or never observed: old numbers are not authority, so drop them, then refresh
        // once for this scope unless an attempt was made in the last 60 s.
        state.delete(r)
        if (now() - lastRefreshAttemptAt >= REFRESH_MIN_GAP_MS) runProbe()
      }
      if (guard(r)) {
        stats.blocked += 1
        return 'blocked'
      }
      stats.admitted += 1
      const e = fresh(r)
      // Local debit only against a live window.
      if (e && e.remaining > 0) state.set(r, { ...e, remaining: e.remaining - 1 })
      return 'admitted'
    },
    /** A background read whose response carries headers (`gh api --include`). Never probes in d2/d3. */
    headerBackgroundRead(r: Resource, response: Budget): 'admitted' | 'blocked' {
      if (policy === 'today' && now() - snapshotAt >= 30_000) runProbe()
      if (guard(r)) {
        stats.blocked += 1
        return 'blocked'
      }
      stats.admitted += 1
      if (policy !== 'today') observe(r, response)
      return 'admitted'
    },
    lateObservation: (r: Resource, b: Budget, epochAtStart: number) => observe(r, b, epochAtStart),
    credentialEpoch: () => credentialEpoch,
    /** Account switch / `gh auth switch` detected for an ambient scope: everything is unknown again. */
    credentialsChanged(): void {
      credentialEpoch += 1
      state.clear()
      snapshotAt = -Infinity
    }
  }
}
