import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import type { GrokAuthSession } from './grok-auth'

type GrokMoneyVal = { val?: string | number }

type GrokUsagePeriod = {
  type?: string
  start?: string
  end?: string
}

export type GrokBillingConfig = {
  creditUsagePercent?: number
  currentPeriod?: GrokUsagePeriod
  billingPeriodStart?: string
  billingPeriodEnd?: string
  subscriptionTier?: string
  monthlyLimit?: GrokMoneyVal
  used?: GrokMoneyVal
  onDemandCap?: GrokMoneyVal
  onDemandUsed?: GrokMoneyVal
  prepaidBalance?: GrokMoneyVal
  isUnifiedBillingUser?: boolean
}

export type GrokBillingResponse = GrokBillingConfig & {
  config?: GrokBillingConfig
}

const WEEKLY_WINDOW_MINUTES = 10_080
const MONTHLY_WINDOW_MINUTES = 43_200

function parseResetDescription(isoString: string | undefined): string | null {
  if (!isoString) {
    return null
  }
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  const isToday = date.toDateString() === new Date().toDateString()
  return isToday
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function timestampsMatch(left: string | undefined, right: string | undefined): boolean {
  const leftTimestamp = left ? Date.parse(left) : Number.NaN
  const rightTimestamp = right ? Date.parse(right) : Number.NaN
  return Number.isFinite(leftTimestamp) && leftTimestamp === rightTimestamp
}

function hasConfirmedWeeklyPeriod(config: GrokBillingConfig): boolean {
  const period = config.currentPeriod
  // Why: matching billing bounds only prove the current period IS the billing
  // period; they say nothing about consumption (#15740), so resolveWeeklyPercent
  // rules out the other consumption evidence before trusting this.
  return (
    period?.type === 'USAGE_PERIOD_TYPE_WEEKLY' &&
    timestampsMatch(period.start, config.billingPeriodStart) &&
    timestampsMatch(period.end, config.billingPeriodEnd)
  )
}

function parseMoneyVal(value: GrokMoneyVal | undefined): number | null {
  const raw = value?.val
  const num = typeof raw === 'string' ? Number.parseFloat(raw) : raw
  return typeof num === 'number' && Number.isFinite(num) ? num : null
}

function usageScalars(config: GrokBillingConfig): (GrokMoneyVal | undefined)[] {
  return [
    config.onDemandCap,
    config.onDemandUsed,
    config.prepaidBalance,
    config.monthlyLimit,
    config.used
  ]
}

// Why: proto3 JSON drops default zeros, so an omitted percent can mean zero —
// but only an explicitly-emitted zero proves this encoder keeps them. #15740
// ships `onDemandUsed: {val: 0}`, so there the omission means "not reported"
// and must never render as 0%. Non-zero money fields prove nothing either way,
// so #9214/#9219 accounts that carry only those keep their genuine 0%.
function emitsExplicitZeroScalar(config: GrokBillingConfig): boolean {
  return usageScalars(config).some((value) => parseMoneyVal(value) === 0)
}

export function reportsAnyUsageScalar(config: GrokBillingConfig): boolean {
  return usageScalars(config).some((value) => parseMoneyVal(value) !== null)
}

function resolveWeeklyPercent(config: GrokBillingConfig): number | null {
  const reported = config.creditUsagePercent
  if (typeof reported === 'number' && Number.isFinite(reported)) {
    return reported
  }
  if (reported !== undefined) {
    return null
  }
  // Why: infer the dropped zero only when nothing else in the payload speaks
  // for consumption — an explicit zero proves the encoder keeps defaults, and a
  // computable budget pair is a real monthly number this must not shadow.
  if (emitsExplicitZeroScalar(config) || mapMonthlyUsage(config) !== null) {
    return null
  }
  return hasConfirmedWeeklyPeriod(config) ? 0 : null
}

export function mapWeeklyCredits(config: GrokBillingConfig): RateLimitWindow | null {
  const usedPercent = resolveWeeklyPercent(config)
  if (usedPercent === null) {
    return null
  }
  const periodEnd = config.currentPeriod?.end ?? config.billingPeriodEnd
  const resetsAt = periodEnd ? Date.parse(periodEnd) : null
  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    windowMinutes: WEEKLY_WINDOW_MINUTES,
    resetsAt: resetsAt !== null && Number.isFinite(resetsAt) ? resetsAt : null,
    resetDescription: parseResetDescription(periodEnd)
  }
}

export function mapMonthlyUsage(config: GrokBillingConfig): RateLimitWindow | null {
  const limit = parseMoneyVal(config.monthlyLimit)
  const used = parseMoneyVal(config.used)
  // Why: a zero, missing or unparseable denominator yields no window rather
  // than NaN/Infinity or a fabricated 0%.
  if (limit === null || used === null || limit <= 0) {
    return null
  }
  const usedPercent = Math.min(100, Math.max(0, (used / limit) * 100))
  const periodEnd = config.currentPeriod?.end ?? config.billingPeriodEnd
  const resetsAt = periodEnd ? Date.parse(periodEnd) : null
  return {
    usedPercent,
    windowMinutes: MONTHLY_WINDOW_MINUTES,
    resetsAt: resetsAt !== null && Number.isFinite(resetsAt) ? resetsAt : null,
    resetDescription: parseResetDescription(periodEnd)
  }
}

// Why: a flat response can carry monthly/on-demand fields and no percent at all
// (#15740); keying only on creditUsagePercent misreported those as "no config".
const FLAT_BILLING_FIELDS: readonly (keyof GrokBillingConfig)[] = [
  'creditUsagePercent',
  'currentPeriod',
  'billingPeriodStart',
  'billingPeriodEnd',
  'subscriptionTier',
  'monthlyLimit',
  'used',
  'onDemandCap',
  'onDemandUsed',
  'prepaidBalance'
]

export function resolveBillingConfig(data: GrokBillingResponse): GrokBillingConfig | null {
  if (data.config) {
    return data.config
  }
  return FLAT_BILLING_FIELDS.some((field) => data[field] !== undefined) ? data : null
}

export function billingUsageResult(
  windows: { weekly?: RateLimitWindow | null; monthly?: RateLimitWindow | null },
  config: GrokBillingConfig,
  session: GrokAuthSession
): ProviderRateLimits {
  const tier = config.subscriptionTier?.trim()
  const authLabel = session.email?.trim() || session.userId || 'Grok account'
  const provenance = tier ? `${authLabel} (${tier})` : authLabel
  return {
    provider: 'grok',
    session: null,
    weekly: windows.weekly ?? null,
    ...(windows.monthly ? { monthly: windows.monthly } : {}),
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: {
      source: 'oauth',
      authProvenance: provenance,
      authAccountId: session.userId?.trim() || session.email?.trim().toLowerCase() || undefined
    }
  }
}
