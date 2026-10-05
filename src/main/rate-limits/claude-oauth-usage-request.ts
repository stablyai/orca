import { net, session } from 'electron'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import { createOAuthUsageError } from './claude-oauth-usage-error'
import { mapClaudeUsageWindow, type ClaudeUsageWindowInput } from './claude-usage-window'
import { abortedClaudeRateLimitResult } from './claude-usage-result'
import { mapClaudeResetGrants, warnIfClaudeResetsNeedNewerCli } from './claude-reset-grants'

const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
// Why: `cedar_ember=1` opts into the earned-reset block, which the server only answers for a
// Claude Code CLI surface at or above a minimum version; below it the block reports ineligible.
const OAUTH_USAGE_REQUEST_URL = `${OAUTH_USAGE_URL}?cedar_ember=1`
const CLAUDE_CLI_USER_AGENT = 'claude-cli/2.1.280 (external, cli)'
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
  limits?: OAuthUsageLimit[] | null
  cedar_ember?: unknown
}

async function ensureProxyFromEnvironment(): Promise<void> {
  await ensureElectronProxyFromEnvironment({
    proxySession: session.defaultSession,
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

  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(API_TIMEOUT_MS)])
    : AbortSignal.timeout(API_TIMEOUT_MS)

  try {
    const response = await net.fetch(OAUTH_USAGE_REQUEST_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': CLAUDE_CLI_USER_AGENT
      },
      signal: requestSignal
    })
    if (!response.ok) {
      throw await createOAuthUsageError(response)
    }

    const data = (await response.json()) as OAuthUsageResponse
    if (signal?.aborted) {
      return abortedClaudeRateLimitResult()
    }
    warnIfClaudeResetsNeedNewerCli(data.cedar_ember, CLAUDE_CLI_USER_AGENT)
    return {
      provider: 'claude',
      session: mapClaudeUsageWindow(data.five_hour, 300),
      weekly: mapClaudeUsageWindow(data.seven_day, 10080),
      fableWeekly: mapFableWeeklyWindow(data),
      rateLimitResetCredits: mapClaudeResetGrants(data.cedar_ember),
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }
  } catch (error) {
    if (signal?.aborted) {
      return abortedClaudeRateLimitResult()
    }
    throw error
  }
}
