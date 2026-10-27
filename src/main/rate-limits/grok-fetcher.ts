import { getMainHttpClient } from '../network/http-client'
import type {
  ProviderRateLimits,
  RateLimitWindow,
  UsageRateLimitMetadata
} from '../../shared/rate-limit-types'
import { abortSignalWithTimeout } from '../lib/abort-signal-with-timeout'
import { classifyThrownUsageRequestError } from './usage-request-failure-kind'
import {
  isGrokAccessTokenFresh,
  readGrokAuthSession,
  type GrokAuthReadResult,
  type GrokAuthSession
} from './grok-auth'

// xAI requires the billing endpoint/headers used by Grok CLI.
const GROK_CLI_PROXY_BASE =
  process.env.GROK_CLI_CHAT_PROXY_BASE_URL?.trim().replace(/\/$/, '') ||
  'https://cli-chat-proxy.grok.com/v1'
const BILLING_CREDITS_URL = `${GROK_CLI_PROXY_BASE}/billing?format=credits`
// Some unified accounts expose monthly budget only in the default billing view.
const BILLING_DEFAULT_URL = `${GROK_CLI_PROXY_BASE}/billing`
const API_TIMEOUT_MS = 10_000
const WEEKLY_WINDOW_MINUTES = 10_080
const MONTHLY_WINDOW_MINUTES = 43_200

const GROK_CLI_AUTH_HEADER = 'xai-grok-cli'

type GrokMoneyVal = { val?: string | number }

type GrokUsagePeriod = {
  type?: string
  start?: string
  end?: string
}

type GrokBillingConfig = {
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

type GrokBillingResponse = GrokBillingConfig & {
  config?: GrokBillingConfig
}

function result(
  status: ProviderRateLimits['status'],
  error: string | null,
  usageMetadata?: UsageRateLimitMetadata
): ProviderRateLimits {
  return {
    provider: 'grok',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status,
    ...(usageMetadata ? { usageMetadata } : {})
  }
}

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
  // Matching weekly bounds prove the period, not consumption; resolveWeeklyPercent checks other evidence first (#15740).
  return (
    period?.type === 'USAGE_PERIOD_TYPE_WEEKLY' &&
    timestampsMatch(period.start, config.billingPeriodStart) &&
    timestampsMatch(period.end, config.billingPeriodEnd)
  )
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

function omittedPercentIsUnreported(config: GrokBillingConfig): boolean {
  // A strict zero cap rejects numeric prefixes like "0invalid" accepted by parseMoneyVal.
  if (parseMoneyVal(config.onDemandCap) === 0 && Number(config.onDemandCap?.val) === 0) {
    return [config.onDemandUsed, config.used].some((value) => (parseMoneyVal(value) ?? 0) > 0)
  }
  return usageScalars(config).some((value) => parseMoneyVal(value) === 0)
}

function reportsAnyUsageScalar(config: GrokBillingConfig): boolean {
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
  // A computable monthly budget must not be relabelled as weekly zero usage.
  if (omittedPercentIsUnreported(config) || mapMonthlyUsage(config) !== null) {
    return null
  }
  return hasConfirmedWeeklyPeriod(config) ? 0 : null
}

function mapWeeklyCredits(config: GrokBillingConfig): RateLimitWindow | null {
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

function parseMoneyVal(value: GrokMoneyVal | undefined): number | null {
  const raw = value?.val
  const num = typeof raw === 'string' ? Number.parseFloat(raw) : raw
  return typeof num === 'number' && Number.isFinite(num) ? num : null
}

function mapMonthlyUsage(config: GrokBillingConfig): RateLimitWindow | null {
  const limit = parseMoneyVal(config.monthlyLimit)
  const used = parseMoneyVal(config.used)
  // Invalid or zero denominators cannot establish quota percentages.
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

function grokRequestHeaders(session: GrokAuthSession): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.accessToken}`,
    'X-XAI-Token-Auth': GROK_CLI_AUTH_HEADER,
    Accept: 'application/json'
  }
  if (session.userId) {
    headers['x-userid'] = session.userId
  }
  return headers
}

// Flat monthly/on-demand payloads can omit percent; testing percent alone falsely reports missing config (#15740).
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

function resolveBillingConfig(data: GrokBillingResponse): GrokBillingConfig | null {
  if (data.config) {
    return data.config
  }
  return FLAT_BILLING_FIELDS.some((field) => data[field] !== undefined) ? data : null
}

function billingUsageResult(
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
      authProvenance: provenance
    }
  }
}

type GrokBillingFetchOutcome =
  | { kind: 'data'; data: GrokBillingResponse }
  | { kind: 'result'; result: ProviderRateLimits }

async function fetchBillingData(
  url: string,
  session: GrokAuthSession,
  signal?: AbortSignal
): Promise<GrokBillingFetchOutcome> {
  const res = await getMainHttpClient().fetch(url, {
    headers: grokRequestHeaders(session),
    signal: abortSignalWithTimeout(signal, API_TIMEOUT_MS)
  })
  if (res.status === 401 || res.status === 403) {
    return {
      kind: 'result',
      result: result('error', `Grok usage request unauthorized (HTTP ${res.status})`)
    }
  }
  if (!res.ok) {
    return {
      kind: 'result',
      result: result('error', `Grok usage request failed (HTTP ${res.status})`)
    }
  }
  const data: unknown = await res.json()
  return {
    kind: 'data',
    data: typeof data === 'object' && data !== null ? (data as GrokBillingResponse) : {}
  }
}

type GrokMonthlyFallbackOutcome =
  | { kind: 'window'; window: RateLimitWindow | null; config: GrokBillingConfig }
  | { kind: 'result'; result: ProviderRateLimits }

// Propagate request errors so stale monthly quota survives; only successful allowance-free responses mean unavailable.
async function fetchMonthlyUsageFallback(
  session: GrokAuthSession,
  signal?: AbortSignal
): Promise<GrokMonthlyFallbackOutcome> {
  const outcome = await fetchBillingData(BILLING_DEFAULT_URL, session, signal)
  if (outcome.kind === 'result') {
    return outcome
  }
  const config = outcome.data.config ?? outcome.data
  return { kind: 'window', window: mapMonthlyUsage(config), config }
}

// Grok CLI owns login/refresh; Orca only reads its session file.
export async function fetchGrokRateLimits(
  options: { signal?: AbortSignal; authReadResult?: GrokAuthReadResult } = {}
): Promise<ProviderRateLimits> {
  const readResult = options.authReadResult ?? readGrokAuthSession()
  if (readResult.status === 'missing') {
    return result('unavailable', 'Not signed in to Grok — run grok login')
  }
  if (readResult.status === 'error') {
    return result('error', readResult.error)
  }
  const session = readResult.session
  if (!isGrokAccessTokenFresh(session)) {
    // Missing auth returned earlier; this stored session refreshes on next Grok use, so do not request login (#8497).
    return result(
      'error',
      'Grok sign-in expired — run grok on the computer running Orca; sign in if prompted. No chat message is needed.',
      { failureKind: 'delegated-refresh-required', source: 'oauth' }
    )
  }

  try {
    const outcome = await fetchBillingData(BILLING_CREDITS_URL, session, options.signal)
    if (outcome.kind === 'result') {
      return outcome.result
    }
    const config = resolveBillingConfig(outcome.data)
    // Successful allowance-free plans hide the bar instead of showing a permanent error.
    if (!config) {
      return result('unavailable', 'Grok billing response did not include config')
    }
    const weekly = mapWeeklyCredits(config)
    if (weekly) {
      return billingUsageResult({ weekly }, config, session)
    }
    // Credits responses may already carry monthly budgets; preserve their window and avoid a redundant request.
    const creditsMonthly = mapMonthlyUsage(config)
    if (creditsMonthly) {
      return billingUsageResult({ monthly: creditsMonthly }, config, session)
    }
    // A percent-free credits view may still have monthly quota in the default view.
    const fallback = await fetchMonthlyUsageFallback(session, options.signal)
    if (fallback.kind === 'result') {
      return fallback.result
    }
    if (fallback.window) {
      return billingUsageResult({ monthly: fallback.window }, config, session)
    }
    // Reported spend without a computable percent is unknown usage, not zero or quota-less.
    return reportsAnyUsageScalar(config) || reportsAnyUsageScalar(fallback.config)
      ? result('unavailable', 'Grok did not report a usage percentage for this account')
      : result('unavailable', 'Grok billing response did not include credit usage')
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Grok usage request failed'
    return result('error', message, { failureKind: classifyThrownUsageRequestError(err) })
  }
}
