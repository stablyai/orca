import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import type { KiroUsageSnapshot } from '../../shared/kiro-usage-types'

const MONTHLY_WINDOW_MINUTES = 43_200 // 30 days

// Parse a "YYYY-MM-DD" reset date to a Unix ms timestamp (local midnight of
// that day), or null when absent/invalid.
function resetsAtFrom(resetsOn: string | null): number | null {
  if (!resetsOn) {
    return null
  }
  const ts = Date.parse(`${resetsOn}T00:00:00`)
  return Number.isFinite(ts) ? ts : null
}

// Map the Kiro plan quota to a ProviderRateLimits with a single monthly window,
// so it renders in the usage roster exactly like Claude/Codex ('X% used'),
// with the reset date driving the countdown and credits carried for the panel.
export function kiroUsageToProviderRateLimits(snapshot: KiroUsageSnapshot): ProviderRateLimits {
  const base = {
    provider: 'kiro' as const,
    session: null,
    weekly: null,
    updatedAt: snapshot.updatedAt
  }

  if (snapshot.status === 'unavailable') {
    return { ...base, monthly: null, status: 'unavailable', error: snapshot.error }
  }
  if (snapshot.status !== 'ok' || !snapshot.quota) {
    return { ...base, monthly: null, status: 'error', error: snapshot.error }
  }

  const q = snapshot.quota
  const resetsAt = resetsAtFrom(q.resetsOn)
  return {
    ...base,
    monthly: {
      usedPercent: q.usedPercent,
      windowMinutes: MONTHLY_WINDOW_MINUTES,
      resetsAt,
      resetDescription: q.resetsOn
    },
    planType: q.plan,
    kiroCredits: { used: q.used, limit: q.limit },
    status: 'ok',
    error: null
  }
}
