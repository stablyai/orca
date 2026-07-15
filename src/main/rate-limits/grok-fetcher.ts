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
// Why: unified-billing accounts have no weekly credits; their included monthly
// budget is only present in the default (format-less) billing view.
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

function mapWeeklyCredits(config: GrokBillingConfig): RateLimitWindow | null {
  const usedPercent = config.creditUsagePercent
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) {
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
  if (limit === null || used === null || limit <= 0) {
    return null
  }
  const periodEnd = config.currentPeriod?.end ?? config.billingPeriodEnd
  const resetsAt = periodEnd ? Date.parse(periodEnd) : null
  return {
    usedPercent: Math.min(100, Math.max(0, (used / limit) * 100)),
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

function resolveBillingConfig(data: GrokBillingResponse): GrokBillingConfig | null {
  if (data.config) {
    return data.config
  }
  if (typeof data.creditUsagePercent === 'number') {
    return data
  }
  return null
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
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(API_TIMEOUT_MS)])
    : AbortSignal.timeout(API_TIMEOUT_MS)
  const res = await net.fetch(url, {
    headers: grokRequestHeaders(session),
    signal: requestSignal
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
  | { kind: 'window'; window: RateLimitWindow | null }
  | { kind: 'result'; result: ProviderRateLimits }

// Why: request failures propagate as 'error' (thrown errors reach the caller's
// catch) so the stale policy keeps the last good monthly snapshot — the
// 'unavailable' status would discard it. Only a successful response without
// monthly fields means the account truly has no visible quota.
async function fetchMonthlyUsageFallback(
  session: GrokAuthSession,
  signal?: AbortSignal
): Promise<GrokMonthlyFallbackOutcome> {
  const outcome = await fetchBillingData(BILLING_DEFAULT_URL, session, signal)
  if (outcome.kind === 'result') {
    return outcome
  }
  const config = outcome.data.config ?? outcome.data
  return { kind: 'window', window: mapMonthlyUsage(config) }
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
    // Why: a genuine sign-out returns 'missing' earlier, so reaching here always
    // means a stored, refreshable session — Grok CLI refreshes the access token
    // on its next run, so don't tell users to re-run `grok login` (#8497).
    return result('error', 'Grok access token expired — Grok CLI will refresh it on next use')
  }

  try {
    const outcome = await fetchBillingData(BILLING_CREDITS_URL, session, options.signal)
    if (outcome.kind === 'result') {
      return outcome.result
    }
    const config = resolveBillingConfig(outcome.data)
    // Why: a 200 without credit usage means the plan has no weekly credits —
    // 'unavailable' hides the bar (like Claude on API-key billing); 'error'
    // would paint a permanent alert for a signed-in account that has no quota.
    if (!config) {
      return result('unavailable', 'Grok billing response did not include config')
    }
    const weekly = mapWeeklyCredits(config)
    if (weekly) {
      return billingUsageResult({ weekly }, config, session)
    }
    // Why: unified-billing accounts report a monthly included-usage budget
    // instead of weekly credits; the credits view omits creditUsagePercent
    // for them, so read the default billing view before giving up.
    const fallback = await fetchMonthlyUsageFallback(session, options.signal)
    if (fallback.kind === 'result') {
      return fallback.result
    }
    if (fallback.window) {
      return billingUsageResult({ monthly: fallback.window }, config, session)
    }
    return result('unavailable', 'Grok billing response did not include credit usage')
  } catch (err) {
    return result('error', err instanceof Error ? err.message : 'Grok usage request failed')
  }
}
