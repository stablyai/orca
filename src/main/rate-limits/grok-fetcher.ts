import { net } from 'electron'
import type {
  ProviderRateLimits,
  RateLimitWindow,
  UsageRateLimitMetadata
} from '../../shared/rate-limit-types'
import {
  isGrokAccessTokenFresh,
  readGrokAuthSession,
  type GrokAuthReadResult,
  type GrokAuthSession
} from './grok-auth'
import { supplementGrokRateLimitResetCredits } from './grok-reset-credit-client'
import type { RateLimitResetCredits } from './codex-reset-credit-client'
import {
  billingUsageResult,
  mapMonthlyUsage,
  mapWeeklyCredits,
  resolveBillingConfig,
  type GrokBillingResponse
} from './grok-billing-mappers'

// Why: billing URL and headers must match Grok CLI or xAI rejects the request.
const GROK_CLI_PROXY_BASE =
  process.env.GROK_CLI_CHAT_PROXY_BASE_URL?.trim().replace(/\/$/, '') ||
  'https://cli-chat-proxy.grok.com/v1'
const BILLING_CREDITS_URL = `${GROK_CLI_PROXY_BASE}/billing?format=credits`
// Why: some unified-billing accounts expose only a monthly included budget,
// which is present in the default (format-less) billing view.
const BILLING_DEFAULT_URL = `${GROK_CLI_PROXY_BASE}/billing`
const API_TIMEOUT_MS = 10_000

const GROK_CLI_AUTH_HEADER = 'xai-grok-cli'

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
  options: {
    signal?: AbortSignal
    authReadResult?: GrokAuthReadResult
    previousRateLimitResetCredits?: RateLimitResetCredits
    previousAuthAccountId?: string
  } = {}
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
    // Why: a 200 without credit usage means the plan has no weekly credits —
    // 'unavailable' hides the bar (like Claude on API-key billing); 'error'
    // would paint a permanent alert for a signed-in account that has no quota.
    if (!config) {
      return result('unavailable', 'Grok billing response did not include config')
    }
    const weekly = mapWeeklyCredits(config)
    if (weekly) {
      return await supplementGrokRateLimitResetCredits(
        billingUsageResult({ weekly }, config, session),
        session,
        {
          signal: options.signal,
          previousRateLimitResetCredits: options.previousRateLimitResetCredits,
          previousAuthAccountId: options.previousAuthAccountId
        }
      )
    }
    // Why: some unified-billing accounts expose only a monthly included budget;
    // their credits view omits creditUsagePercent, so read the default view.
    const fallback = await fetchMonthlyUsageFallback(session, options.signal)
    if (fallback.kind === 'result') {
      return fallback.result
    }
    if (fallback.window) {
      return await supplementGrokRateLimitResetCredits(
        billingUsageResult({ monthly: fallback.window }, config, session),
        session,
        {
          signal: options.signal,
          previousRateLimitResetCredits: options.previousRateLimitResetCredits,
          previousAuthAccountId: options.previousAuthAccountId
        }
      )
    }
    return result('unavailable', 'Grok billing response did not include credit usage')
  } catch (err) {
    return result('error', err instanceof Error ? err.message : 'Grok usage request failed')
  }
}
