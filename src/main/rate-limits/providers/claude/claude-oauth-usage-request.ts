import type {
  ProviderRateLimits,
  RateLimitWindow
} from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { ClaudeRuntimeAuthPreparation } from '../../../claude-accounts/runtime-auth/runtime-auth-types'
import {
  claudeOAuthHeaders,
  invalidateClaudeOAuthVersion,
  requestClaudeOAuth
} from './claude-oauth-request'
import { mapClaudeResetCredits } from './claude-reset-credit-response'
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

// Keep spend in the normal meter; the reset-only query can opt out of it.
const OAUTH_USAGE_PATH = '/api/oauth/usage?cedar_ember=1'

type OAuthUsageLimit = {
  kind?: string
  percent?: number
  resets_at?: string | number
  is_active?: boolean
  scope?: { model?: { display_name?: string } | null } | null
}

type OAuthUsageResponse = {
  cedar_ember?: unknown
  five_hour?: ClaudeUsageWindowInput
  seven_day?: ClaudeUsageWindowInput
  fable_weekly?: ClaudeUsageWindowInput
  fable_seven_day?: ClaudeUsageWindowInput
  seven_day_fable?: ClaudeUsageWindowInput
  spend?: ClaudeOAuthSpend
  extra_usage?: ClaudeOAuthExtraUsage
  limits?: OAuthUsageLimit[] | null
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
  signal?: AbortSignal,
  auth?: ClaudeRuntimeAuthPreparation
): Promise<ProviderRateLimits> {
  if (signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  const headers = await claudeOAuthHeaders(token, auth)

  let data: OAuthUsageResponse
  try {
    const response = await requestClaudeOAuth(OAUTH_USAGE_PATH, headers, { signal })
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
  const resetCredits = mapClaudeResetCredits(data.cedar_ember)
  if (resetCredits?.ineligibleReason === 'cli_version') {
    invalidateClaudeOAuthVersion(auth)
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
    claudeResetCredits: resetCredits,
    updatedAt: Date.now(),
    error: null,
    status: 'ok'
  }
}
