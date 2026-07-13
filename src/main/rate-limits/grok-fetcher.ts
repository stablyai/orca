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
const API_TIMEOUT_MS = 10_000
const WEEKLY_WINDOW_MINUTES = 10_080

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

function mapBillingResponse(
  data: GrokBillingResponse,
  session: GrokAuthSession
): ProviderRateLimits {
  const config = resolveBillingConfig(data)
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
    const res = await net.fetch(BILLING_CREDITS_URL, {
      headers: grokRequestHeaders(session),
      signal
    })
    if (res.status === 401 || res.status === 403) {
      return result('error', `Grok usage request unauthorized (HTTP ${res.status})`)
    }
    if (!res.ok) {
      return result('error', `Grok usage request failed (HTTP ${res.status})`)
    }
    const data: unknown = await res.json()
    return mapBillingResponse(
      typeof data === 'object' && data !== null ? (data as GrokBillingResponse) : {},
      session
    )
  } catch (err) {
    return result('error', err instanceof Error ? err.message : 'Grok usage request failed')
  }
}
