import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'

export const COMMAND_CODE_API_BASE = 'https://api.commandcode.ai'

const SESSION_WINDOW_MINUTES = 300 // 5h
const WEEKLY_WINDOW_MINUTES = 10080 // 7d
const MONTHLY_WINDOW_MINUTES = 30 * 24 * 60

export function buildCommandCodeEndpoint(
  path: string,
  params: Record<string, string | null>
): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) {
      search.set(key, value)
    }
  }
  const query = search.toString()
  return `${COMMAND_CODE_API_BASE}${path}${query ? `?${query}` : ''}`
}

// Why readers and not casts: the `alpha` payloads are outside our control, so
// their shape is a guess until something checks it.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

export function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function asNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function asWindow(
  value: Record<string, unknown> | null,
  windowMinutes: number
): RateLimitWindow | null {
  const cap = asNonNegativeNumber(value?.cap)
  const used = asNonNegativeNumber(value?.used)
  if (cap === null || cap <= 0 || used === null) {
    return null
  }
  const resetAt = asNonNegativeNumber(value?.resetAt)
  return {
    usedPercent: Math.min(100, Math.max(0, (used / cap) * 100)),
    windowMinutes,
    resetsAt: resetAt && resetAt > 0 ? resetAt : null,
    resetDescription: null
  }
}

const PLAN_LABELS: Record<string, string> = {
  'individual-go': 'Go',
  'individual-go-v1': 'Go',
  'individual-goat': 'GOAT',
  'individual-pro': 'Pro',
  'individual-pro-v1': 'Pro',
  'individual-provider': 'Provider',
  'individual-max': 'Max',
  'individual-ultra': 'Ultra',
  'teams-pro': 'Teams Pro'
}
const PLAN_IDS_LONGEST_FIRST = Object.keys(PLAN_LABELS).sort(
  (left, right) => right.length - left.length
)

export function planTypeFromCommandCodeId(planId: string | null): string | null {
  if (!planId) {
    return null
  }
  const normalized = planId.toLowerCase().replace(/_/g, '-')
  for (const id of PLAN_IDS_LONGEST_FIRST) {
    if (normalized.startsWith(id)) {
      return PLAN_LABELS[id] ?? null
    }
  }
  return planId
}

export type CommandCodeUsageProjection = {
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
  monthly: RateLimitWindow | null
  extraUsage: ProviderRateLimits['extraUsage']
}

/**
 * Projects the credits payload onto the provider rate-limit model. The plan's
 * monthly bar is derived from the account's own spend + remaining rather than a
 * bundled quota table, so a new plan id can never silently misreport it.
 */
export function projectCommandCodeUsage({
  creditsPayload,
  summaryPayload,
  periodEnd
}: {
  creditsPayload: Record<string, unknown>
  summaryPayload: Record<string, unknown> | null
  periodEnd: string | null
}): CommandCodeUsageProjection {
  const credits = readRecord(creditsPayload.credits)
  const totalRemaining =
    (asNonNegativeNumber(credits?.monthlyCredits) ?? 0) +
    (asNonNegativeNumber(credits?.purchasedCredits) ?? 0) +
    (asNonNegativeNumber(credits?.freeCredits) ?? 0)
  const totalSpent = asNonNegativeNumber(summaryPayload?.totalCost)

  const windowLimits = readRecord(creditsPayload.windowLimits)
  const limitsApply = windowLimits?.limited !== false
  const session = limitsApply
    ? asWindow(readRecord(windowLimits?.fiveHour), SESSION_WINDOW_MINUTES)
    : null
  const weekly = limitsApply
    ? asWindow(readRecord(windowLimits?.weekly), WEEKLY_WINDOW_MINUTES)
    : null

  const pool = totalSpent === null ? null : totalSpent + totalRemaining
  const resetAt = periodEnd ? Date.parse(periodEnd) : Number.NaN
  const monthly: RateLimitWindow | null =
    totalSpent === null || pool === null || pool <= 0
      ? null
      : {
          usedPercent: Math.min(100, Math.max(0, (totalSpent / pool) * 100)),
          windowMinutes: MONTHLY_WINDOW_MINUTES,
          resetsAt: Number.isNaN(resetAt) ? null : resetAt,
          resetDescription: null
        }

  const hasCreditsInfo = totalRemaining > 0 || (totalSpent ?? 0) > 0
  const extraUsage: ProviderRateLimits['extraUsage'] = hasCreditsInfo
    ? {
        enabled: true,
        disabledReason: null,
        resetsAt: null,
        unit: 'credits',
        balance: totalRemaining,
        unlimited: false
      }
    : null

  return { session, weekly, monthly, extraUsage }
}
