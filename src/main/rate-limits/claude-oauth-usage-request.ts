import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import { getMainHttpClient } from '../network/http-client'
import { abortSignalWithTimeout } from '../lib/abort-signal-with-timeout'
import {
  ClaudeUsageRequestError,
  createOAuthUsageError,
  OAuthUsageError
} from './claude-oauth-usage-error'
import { mapClaudeUsageWindow, type ClaudeUsageWindowInput } from './claude-usage-window'
import { abortedClaudeRateLimitResult } from './claude-usage-result'
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

export async function fetchClaudeOAuthUsage(
  token: string,
  signal?: AbortSignal
): Promise<ProviderRateLimits> {
  if (signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  await ensureProxyFromEnvironment()
  if (signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }

  const requestSignal = abortSignalWithTimeout(signal, API_TIMEOUT_MS)

  let data: OAuthUsageResponse
  try {
    const response = await getMainHttpClient().fetch(OAUTH_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-code/2.1.0'
      },
      signal: requestSignal
    })
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
