import { net } from 'electron'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import {
  isGrokAccessTokenFresh,
  readGrokAuthSession,
  type GrokAuthReadResult,
  type GrokAuthSession
} from './grok-auth'

// Why: billing URL and headers must match Grok CLI or xAI rejects the request.
const GROK_CLI_PROXY_BASE =
  process.env.GROK_CLI_CHAT_PROXY_BASE_URL?.trim().replace(/\/$/, '') ||
  'https://cli-chat-proxy.grok.com/v1'
const BILLING_CREDITS_URL = `${GROK_CLI_PROXY_BASE}/billing?format=credits`
// Why: SuperGrok unified billing sometimes omits creditUsagePercent on
// format=credits; the default billing payload still has used/monthlyLimit.
const BILLING_DEFAULT_URL = `${GROK_CLI_PROXY_BASE}/billing`
const API_TIMEOUT_MS = 10_000
const WEEKLY_WINDOW_MINUTES = 10_080

const GROK_CLI_AUTH_HEADER = 'xai-grok-cli'

type GrokMoneyVal = { val?: string | number }

type GrokUsagePeriod = {
  type?: string
  start?: string
  end?: string
}

type GrokProductUsage = {
  product?: string
  usagePercent?: number
}

type GrokBillingConfig = {
  creditUsagePercent?: number
  currentPeriod?: GrokUsagePeriod
  billingPeriodStart?: string
  billingPeriodEnd?: string
  subscriptionTier?: string
  onDemandCap?: GrokMoneyVal
  onDemandUsed?: GrokMoneyVal
  prepaidBalance?: GrokMoneyVal
  isUnifiedBillingUser?: boolean
  productUsage?: GrokProductUsage[]
  used?: GrokMoneyVal | number
  monthlyLimit?: GrokMoneyVal | number
  limit?: GrokMoneyVal | number
}

type GrokBillingResponse = GrokBillingConfig & {
  config?: GrokBillingConfig
  subscriptionTier?: string
}

function result(status: ProviderRateLimits['status'], error: string | null): ProviderRateLimits {
  return {
    provider: 'grok',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status
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

function unwrapMoneyVal(value: GrokMoneyVal | number | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'object' && value !== null) {
    const raw = value.val
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw
    }
    if (typeof raw === 'string' && raw.trim()) {
      const parsed = Number(raw)
      return Number.isFinite(parsed) ? parsed : null
    }
  }
  return null
}

// Why: xAI has shipped several shapes for the same quota:
// 1) creditUsagePercent on format=credits (preferred)
// 2) productUsage[].usagePercent (per-product shares of the weekly pool)
// 3) used / monthlyLimit money wrappers on the default billing endpoint
function resolveUsedPercent(config: GrokBillingConfig): number | null {
  if (typeof config.creditUsagePercent === 'number' && Number.isFinite(config.creditUsagePercent)) {
    return config.creditUsagePercent
  }

  if (Array.isArray(config.productUsage) && config.productUsage.length > 0) {
    let total = 0
    let found = false
    for (const entry of config.productUsage) {
      if (typeof entry?.usagePercent === 'number' && Number.isFinite(entry.usagePercent)) {
        total += entry.usagePercent
        found = true
      }
    }
    if (found) {
      return total
    }
  }

  const used = unwrapMoneyVal(config.used)
  // Why: prefer monthlyLimit / limit. Do not use onDemandCap as a denominator —
  // it is often 0 even when the weekly pool is active.
  const resolvedLimit = unwrapMoneyVal(config.monthlyLimit) ?? unwrapMoneyVal(config.limit)
  if (used !== null && resolvedLimit !== null && resolvedLimit > 0) {
    return (used / resolvedLimit) * 100
  }

  return null
}

function hasExplicitUsageCounters(config: GrokBillingConfig | null): boolean {
  if (!config) {
    return false
  }
  if (typeof config.creditUsagePercent === 'number' && Number.isFinite(config.creditUsagePercent)) {
    return true
  }
  if (
    Array.isArray(config.productUsage) &&
    config.productUsage.some(
      (entry) => typeof entry?.usagePercent === 'number' && Number.isFinite(entry.usagePercent)
    )
  ) {
    return true
  }
  return unwrapMoneyVal(config.used) !== null
}

function hasWeeklyPoolMetadata(config: GrokBillingConfig): boolean {
  return (
    config.isUnifiedBillingUser === true || config.currentPeriod?.type === 'USAGE_PERIOD_TYPE_WEEKLY'
  )
}

function mapWeeklyCredits(config: GrokBillingConfig): RateLimitWindow | null {
  let usedPercent = resolveUsedPercent(config)
  // Why: unified weekly users can receive a config shell with period metadata
  // before usage counters are populated. After fallback merge, treat that as 0%.
  if (usedPercent === null && hasWeeklyPoolMetadata(config)) {
    usedPercent = 0
  }
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

function resolveBillingConfig(data: GrokBillingResponse): GrokBillingConfig | null {
  if (data.config) {
    // Why: subscriptionTier is sometimes a sibling of config, not nested inside it.
    return {
      ...data.config,
      subscriptionTier: data.config.subscriptionTier ?? data.subscriptionTier
    }
  }
  if (
    typeof data.creditUsagePercent === 'number' ||
    Array.isArray(data.productUsage) ||
    data.used !== undefined ||
    data.monthlyLimit !== undefined
  ) {
    return data
  }
  return null
}

function mergeBillingConfigs(
  primary: GrokBillingConfig | null,
  fallback: GrokBillingConfig | null
): GrokBillingConfig | null {
  if (!primary && !fallback) {
    return null
  }
  if (!primary) {
    return fallback
  }
  if (!fallback) {
    return primary
  }
  return {
    ...fallback,
    ...primary,
    // Prefer primary period / percent; fill gaps from fallback.
    creditUsagePercent: primary.creditUsagePercent ?? fallback.creditUsagePercent,
    productUsage: primary.productUsage ?? fallback.productUsage,
    used: primary.used ?? fallback.used,
    monthlyLimit: primary.monthlyLimit ?? fallback.monthlyLimit,
    limit: primary.limit ?? fallback.limit,
    currentPeriod: primary.currentPeriod ?? fallback.currentPeriod,
    billingPeriodStart: primary.billingPeriodStart ?? fallback.billingPeriodStart,
    billingPeriodEnd: primary.billingPeriodEnd ?? fallback.billingPeriodEnd,
    subscriptionTier: primary.subscriptionTier ?? fallback.subscriptionTier,
    isUnifiedBillingUser: primary.isUnifiedBillingUser ?? fallback.isUnifiedBillingUser
  }
}

function mapBillingResponse(
  data: GrokBillingResponse,
  session: GrokAuthSession,
  fallbackData?: GrokBillingResponse | null
): ProviderRateLimits {
  const config = mergeBillingConfigs(
    resolveBillingConfig(data),
    fallbackData ? resolveBillingConfig(fallbackData) : null
  )
  // Why: a 200 without credit usage means the plan has no weekly credits —
  // 'unavailable' hides the bar (like Claude on API-key billing); 'error'
  // would paint a permanent alert for a signed-in account that has no quota.
  if (!config) {
    return result('unavailable', 'Grok billing response did not include config')
  }
  const weekly = mapWeeklyCredits(config)
  const tier = config.subscriptionTier?.trim()
  const authLabel = session.email?.trim() || session.userId || 'Grok account'
  const provenance = tier ? `${authLabel} (${tier})` : authLabel
  return {
    provider: 'grok',
    session: null,
    weekly,
    updatedAt: Date.now(),
    error: weekly ? null : 'Grok billing response did not include credit usage',
    status: weekly ? 'ok' : 'unavailable',
    usageMetadata: {
      source: 'oauth',
      authProvenance: provenance
    }
  }
}

async function fetchBillingJson(
  url: string,
  session: GrokAuthSession,
  signal: AbortSignal
): Promise<{ ok: true; data: GrokBillingResponse } | { ok: false; status: number } | { ok: false; error: string }> {
  try {
    const res = await net.fetch(url, {
      headers: grokRequestHeaders(session),
      signal
    })
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: `Grok usage request unauthorized (HTTP ${res.status})` }
    }
    if (!res.ok) {
      return { ok: false, status: res.status }
    }
    const data: unknown = await res.json()
    return {
      ok: true,
      data: typeof data === 'object' && data !== null ? (data as GrokBillingResponse) : {}
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Grok usage request failed' }
  }
}

// Why: Orca never runs grok login; it only reads the session file the CLI updates.
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
    return result('error', 'Grok session expired — run grok login to refresh')
  }

  try {
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(API_TIMEOUT_MS)])
      : AbortSignal.timeout(API_TIMEOUT_MS)

    const credits = await fetchBillingJson(BILLING_CREDITS_URL, session, signal)
    if (!credits.ok) {
      if ('error' in credits && credits.error) {
        return result('error', credits.error)
      }
      return result(
        'error',
        `Grok usage request failed (HTTP ${'status' in credits ? credits.status : 'unknown'})`
      )
    }

    const primaryConfig = resolveBillingConfig(credits.data)
    if (hasExplicitUsageCounters(primaryConfig)) {
      return mapBillingResponse(credits.data, session)
    }

    // Why: format=credits can return period metadata without usage counters.
    // Fall back to default /billing which exposes used/monthlyLimit.
    const fallback = await fetchBillingJson(BILLING_DEFAULT_URL, session, signal)
    if (fallback.ok) {
      return mapBillingResponse(credits.data, session, fallback.data)
    }

    return mapBillingResponse(credits.data, session)
  } catch (err) {
    return result('error', err instanceof Error ? err.message : 'Grok usage request failed')
  }
}
