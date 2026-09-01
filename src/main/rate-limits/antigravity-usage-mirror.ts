import type { ProviderRateLimits } from '../../shared/rate-limit-types'

// Why: Orca has no Antigravity endpoint — the Gemini read of shared Google Code Assist quota *is*
// Antigravity's read, which is why a successful one is mirrored verbatim. #15876 stopped this row
// quoting Gemini's raw error and blaming a sign-in that exists; both still hold. It also settled a
// failed read as `unavailable`, taken as a copy choice but really a retention verdict —
// `applyStalePolicy` discards on `unavailable`, retains on `error` — so one failure wiped this row
// and spared Gemini's. One read cannot be Antigravity's when it succeeds and nobody's when it
// fails, so a failed read settles `error` here too. That brings back the generic "Refresh failed"
// label deliberately: the reason below names the shared quota, so no Antigravity request is
// implied, and a bespoke label would suppress the tooltip's "showing cached data" suffix.
const ANTIGRAVITY_NO_SIGN_IN_REASON =
  'Antigravity usage is not available. Orca can only show shared Google Code Assist quota while a Gemini CLI sign-in is connected.'
// Why: this lane now retains the last reading, so the tooltip prints this line above a live
// meter — claiming the usage is unavailable would contradict the numbers beside it.
const ANTIGRAVITY_QUOTA_UNREADABLE_REASON =
  'Orca reads Antigravity usage from the shared Google Code Assist quota, which could not be read right now.'

export function deriveAntigravityRateLimits(gemini: ProviderRateLimits): ProviderRateLimits {
  if (gemini.status === 'ok') {
    return { ...gemini, provider: 'antigravity' }
  }
  // Why: a Gemini `error` means the sign-in exists and the read failed; anything else means there
  // was nothing to read, which is genuinely absent rather than failed.
  const quotaReadFailed = gemini.status === 'error'
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    // Why: reuse the Gemini timestamp so activation freshness checks don't force a refetch every cycle.
    updatedAt: gemini.updatedAt,
    error: quotaReadFailed ? ANTIGRAVITY_QUOTA_UNREADABLE_REASON : ANTIGRAVITY_NO_SIGN_IN_REASON,
    status: quotaReadFailed ? 'error' : 'unavailable'
  }
}
