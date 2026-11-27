import type {
  ProviderRateLimits,
  RateLimitWindow
} from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { ensureElectronProxyFromEnvironment } from '../../../network/proxy-settings'
import { getMainHttpClient, type MainHttpClient } from '../../../network/http-client'
import { abortSignalWithTimeout } from '../../../lib/abort-signal-with-timeout'
import {
  ClaudeUsageRequestError,
  createOAuthUsageError,
  OAuthUsageError
} from './claude-oauth-usage-error'
import { mapClaudeUsageWindow, type ClaudeUsageWindowInput } from './claude-usage-window'
import { abortedClaudeRateLimitResult } from './claude-usage-result'
import { readClaudeSettingsProxy } from './claude-settings-proxy'
import type { NetworkProxySettings } from '../../../../shared/network/network-proxy'
import {
  mapClaudeExtraUsage,
  mapClaudeSpendLimitWindow,
  type ClaudeOAuthExtraUsage,
  type ClaudeOAuthSpend
} from './claude-usage-credits'

const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const API_TIMEOUT_MS = 10_000

type OAuthUsageLimit = {
  kind?: string
  percent?: number
  resets_at?: string | number
  is_active?: boolean
  scope?: { model?: { display_name?: string } | null } | null
}

type OAuthUsageResponse = {
  five_hour?: ClaudeUsageWindowInput
  seven_day?: ClaudeUsageWindowInput
  fable_weekly?: ClaudeUsageWindowInput
  fable_seven_day?: ClaudeUsageWindowInput
  seven_day_fable?: ClaudeUsageWindowInput
  spend?: ClaudeOAuthSpend
  extra_usage?: ClaudeOAuthExtraUsage
  limits?: OAuthUsageLimit[] | null
}

async function ensureProxyFromEnvironment(): Promise<void> {
  await ensureElectronProxyFromEnvironment({
    probeUrl: OAUTH_USAGE_URL
  }).catch(() => {})
}

function mapFableWeeklyWindow(data: OAuthUsageResponse): RateLimitWindow | null {
  const scoped = Array.isArray(data.limits)
    ? data.limits.find(
        (limit) =>
          limit?.kind === 'weekly_scoped' &&
          Number.isFinite(limit.percent) &&
          limit.scope?.model?.display_name?.trim().toLowerCase() === 'fable'
      )
    : undefined
  return (
    mapClaudeUsageWindow(
      scoped ? { used_percentage: scoped.percent, resets_at: scoped.resets_at } : undefined,
      10080
    ) ??
    mapClaudeUsageWindow(data.fable_weekly, 10080) ??
    mapClaudeUsageWindow(data.fable_seven_day, 10080) ??
    mapClaudeUsageWindow(data.seven_day_fable, 10080)
  )
}

function usageRequestInit(
  token: string,
  signal: AbortSignal | undefined,
  timeoutMs: number
): RequestInit {
  return {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-code/2.1.0'
    },
    signal: abortSignalWithTimeout(signal, timeoutMs)
  }
}

type ClaudeUsageAccount = {
  /** The account's Claude folder, whose settings.json proxy Claude uses over the one Orca launches it with. */
  configDir: string
  networkProxySettings?: NetworkProxySettings
}

// Why: a proxy that drops traffic would otherwise add its full timeout to every poll before the fallback.
const PROXY_ATTEMPT_TIMEOUT_MS = 3_000
const FAILED_PROXY_SKIP_MS = 5 * 60_000
const failedProxySkipUntil = new Map<string, number>()

async function fetchThroughAccountProxy(
  client: MainHttpClient,
  token: string,
  signal: AbortSignal | undefined,
  account: ClaudeUsageAccount
): Promise<Response | null> {
  // Headless hosts have no per-request proxy and keep the app-wide policy.
  if (!client.fetchThroughProxy) {
    return null
  }
  const accountProxy = await readClaudeSettingsProxy(
    account.configDir,
    account.networkProxySettings
  )
  const proxyUrl = accountProxy?.httpProxyUrl
  if (!accountProxy || !proxyUrl || (failedProxySkipUntil.get(proxyUrl) ?? 0) > Date.now()) {
    return null
  }
  try {
    const response = await client.fetchThroughProxy(
      accountProxy,
      OAUTH_USAGE_URL,
      usageRequestInit(token, signal, PROXY_ATTEMPT_TIMEOUT_MS)
    )
    failedProxySkipUntil.delete(proxyUrl)
    return response
  } catch (error) {
    if (signal?.aborted) {
      throw error
    }
    // A settings.json proxy that is down should not hide usage the app-wide route can still read.
    failedProxySkipUntil.set(proxyUrl, Date.now() + FAILED_PROXY_SKIP_MS)
    return null
  }
}

async function requestUsage(
  token: string,
  signal: AbortSignal | undefined,
  account: ClaudeUsageAccount | undefined
): Promise<Response> {
  const client = getMainHttpClient()
  const proxied = account ? await fetchThroughAccountProxy(client, token, signal, account) : null
  if (proxied) {
    return proxied
  }
  await ensureProxyFromEnvironment()
  return client.fetch(OAUTH_USAGE_URL, usageRequestInit(token, signal, API_TIMEOUT_MS))
}

export async function fetchClaudeOAuthUsage(
  token: string,
  signal?: AbortSignal,
  account?: ClaudeUsageAccount
): Promise<ProviderRateLimits> {
  if (signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }

  let data: OAuthUsageResponse
  try {
    const response = await requestUsage(token, signal, account)
    if (!response.ok) {
      throw await createOAuthUsageError(response)
    }

    data = await response.json()
  } catch (error) {
    if (signal?.aborted) {
      return abortedClaudeRateLimitResult()
    }
    throw error instanceof OAuthUsageError ? error : new ClaudeUsageRequestError(error)
  }
  if (signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  const session = mapClaudeUsageWindow(data.five_hour, 300)
  const weekly = mapClaudeUsageWindow(data.seven_day, 10080)
  return {
    provider: 'claude',
    session,
    weekly,
    fableWeekly: mapFableWeeklyWindow(data),
    // Why only without plan windows: there, spend is overage after a cap, not the account's limit.
    monthly: session || weekly ? null : mapClaudeSpendLimitWindow(data),
    extraUsage: mapClaudeExtraUsage(data),
    updatedAt: Date.now(),
    error: null,
    status: 'ok'
  }
}
