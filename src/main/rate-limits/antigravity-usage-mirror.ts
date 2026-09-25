import type { ProviderRateLimits } from '../../shared/rate-limit-types'

// Why: the Antigravity CLI keeps its token in the OS keyring, not in the files the Gemini
// fetcher reads, so Orca never actually queries Antigravity. Only a *successful* Gemini read
// describes shared Google Code Assist quota; republishing a Gemini failure under the
// Antigravity provider id surfaced "Refresh failed" for a request that was never attempted.
const ANTIGRAVITY_NO_SIGN_IN_REASON =
  'Antigravity usage is not available. Orca can only show shared Google Code Assist quota while a Gemini CLI sign-in is connected.'
// Why: a Gemini `error` means the sign-in exists and the quota read failed, so blaming a missing sign-in would misdirect the user.
const ANTIGRAVITY_QUOTA_UNREADABLE_REASON =
  'Antigravity usage is not available. Orca reads it from the shared Google Code Assist quota, which could not be read right now.'

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
