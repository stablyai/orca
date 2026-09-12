import type { ProviderRateLimits, UsageRateLimitFailureKind } from '../../shared/rate-limit-types'

// Why: this is the fallback for when the direct Antigravity read has no answer of its own — no
// sign-in on any host, or an account whose quota exists only as the shared Google Code Assist
// pool. Only a *successful* Gemini read describes that pool; republishing a Gemini failure under
// the Antigravity provider id surfaced "Refresh failed" for a request that was never attempted.
const ANTIGRAVITY_NO_SIGN_IN_REASON =
  'Antigravity usage is not available. Orca can only show shared Google Code Assist quota while a Gemini CLI sign-in is connected.'
// Why: a Gemini `error` means the sign-in exists and the quota read failed, so blaming a missing sign-in would misdirect the user.
const ANTIGRAVITY_QUOTA_UNREADABLE_REASON =
  'Antigravity usage is not available. Orca reads it from the shared Google Code Assist quota, which could not be read right now.'

// Why: an expired sign-in and a host we could not reach are real answers about Antigravity, and
// each carries its own remedy; replacing them with Gemini's numbers hides the failure and the fix.
// Every other verdict — no sign-in anywhere, no Antigravity grant, a transient endpoint failure —
// leaves the shared-pool mirror as the best answer still available.
const DIRECT_VERDICTS_WORTH_SURFACING: ReadonlySet<UsageRateLimitFailureKind> = new Set([
  'stale-token',
  'network'
])

/** Picks between a direct Antigravity read and the shared Code Assist mirror. */
export function resolveAntigravityRateLimits(
  direct: ProviderRateLimits | null,
  gemini: ProviderRateLimits
): ProviderRateLimits {
  if (direct?.status === 'ok') {
    return direct
  }
  const failureKind = direct?.usageMetadata?.failureKind
  if (failureKind && DIRECT_VERDICTS_WORTH_SURFACING.has(failureKind)) {
    return direct as ProviderRateLimits
  }
  return deriveAntigravityRateLimits(gemini)
}

export function deriveAntigravityRateLimits(gemini: ProviderRateLimits): ProviderRateLimits {
  if (gemini.status === 'ok') {
    return { ...gemini, provider: 'antigravity' }
  }
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    // Why: reuse the Gemini timestamp so activation freshness checks don't force a refetch every cycle.
    updatedAt: gemini.updatedAt,
    error:
      gemini.status === 'unavailable'
        ? ANTIGRAVITY_NO_SIGN_IN_REASON
        : ANTIGRAVITY_QUOTA_UNREADABLE_REASON,
    status: 'unavailable'
  }
}
