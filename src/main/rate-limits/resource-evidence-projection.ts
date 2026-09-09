import type {
  ProviderRateLimits,
  RateLimitState,
  RateLimitWindow
} from '../../shared/rate-limit-types'
import type {
  ResourceEvidence,
  ResourceEvidenceProvider,
  ResourceEvidenceWindow
} from '../../shared/resource-evidence-types'

// Why: the caller's horizon roles come from the window's real duration; an
// unrecognised duration stays UNKNOWN rather than guessing a horizon.
const WINDOW_ROLE_BY_MINUTES: Record<number, 'BURST' | 'BUDGET'> = {
  60: 'BURST', // Gemini hourly per-model bucket
  300: 'BURST', // 5-hour session window
  10080: 'BUDGET', // 7-day weekly window
  43200: 'BUDGET' // 30-day monthly window (OpenCode Go, Grok unified billing)
}

function toIso(ms: number | null | undefined): string | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function projectWindow(window: RateLimitWindow, pool?: string): ResourceEvidenceWindow {
  const usedPercent = Math.min(100, Math.max(0, window.usedPercent))
  return {
    role: WINDOW_ROLE_BY_MINUTES[window.windowMinutes] ?? 'UNKNOWN',
    windowMinutes: window.windowMinutes,
    remainingRatio: Math.round((1 - usedPercent / 100) * 100) / 100,
    remainingRatioGranularity: 0.01,
    resetAt: toIso(window.resetsAt),
    resetAtSource: 'unknown',
    ...(pool ? { pool } : {})
  }
}

function projectProvider(
  limits: ProviderRateLimits,
  queriedAtMs: number
): ResourceEvidenceProvider {
  const windows: ResourceEvidenceWindow[] = []
  if (limits.session) windows.push(projectWindow(limits.session))
  if (limits.weekly) windows.push(projectWindow(limits.weekly))
  if (limits.monthly) windows.push(projectWindow(limits.monthly))
  if (limits.fableWeekly) windows.push(projectWindow(limits.fableWeekly))
  for (const bucket of limits.buckets ?? []) windows.push(projectWindow(bucket, bucket.name))

  const updatedAtMs =
    typeof limits.updatedAt === 'number' && Number.isFinite(limits.updatedAt)
      ? limits.updatedAt
      : null

  const extras: NonNullable<ResourceEvidenceProvider['extras']> = {}
  if (typeof limits.planType === 'string') extras.planType = limits.planType
  if (limits.rateLimitResetCredits) {
    extras.resetCreditsAvailable = limits.rateLimitResetCredits.availableCount
  }

  return {
    available: limits.status === 'ok' && windows.length > 0,
    status: limits.status,
    sourceUpdatedAt: toIso(updatedAtMs),
    dataAgeMs: updatedAtMs === null ? null : Math.max(0, queriedAtMs - updatedAtMs),
    rateLimited: limits.usageMetadata?.failureKind === 'rate-limited',
    retryAt: toIso(limits.usageMetadata?.retryAtMs ?? null),
    windows,
    ...(Object.keys(extras).length > 0 ? { extras } : {})
  }
}

/**
 * Projects the identity-free subset of RateLimitState into machine-readable
 * resource evidence. Pure and deterministic; never reads the account arrays,
 * emails, credentials, or raw provider payloads that sit alongside it.
 */
export function projectResourceEvidence(
  state: RateLimitState,
  options: { queriedAtMs: number }
): ResourceEvidence {
  const entries: readonly [ProviderRateLimits['provider'], ProviderRateLimits | null][] = [
    ['claude', state.claude],
    ['codex', state.codex],
    ['gemini', state.gemini],
    ['antigravity', state.antigravity],
    ['grok', state.grok],
    ['kimi', state.kimi],
    ['minimax', state.minimax],
    ['opencode-go', state.opencodeGo]
  ]
  const providers: ResourceEvidence['providers'] = {}
  for (const [name, limits] of entries) {
    if (limits) providers[name] = projectProvider(limits, options.queriedAtMs)
  }
  return { queriedAt: new Date(options.queriedAtMs).toISOString(), providers }
}
