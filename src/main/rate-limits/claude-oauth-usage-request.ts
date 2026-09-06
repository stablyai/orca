import { net, session } from 'electron'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import { createOAuthUsageError, OAuthUsageUnreadableError } from './claude-oauth-usage-error'
import { mapClaudeUsageWindow, type ClaudeUsageWindowInput } from './claude-usage-window'
import { isReadableUsageBody, namesReadableUsageField } from './unreadable-usage-response'
import { abortedClaudeRateLimitResult } from './claude-usage-result'

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
  limits?: OAuthUsageLimit[] | null
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

const USAGE_RESPONSE_KEYS = [
  'five_hour',
  'seven_day',
  'fable_weekly',
  'fable_seven_day',
  'seven_day_fable',
  'limits'
] as const

// Why: an unreadable 200 maps to the same nulls a genuinely empty account would, and the stale
// policy writes an `ok` straight over the last real usage — so no-window is never a success here.
// The first two shapes are provably unreadable; the third is the case Orca cannot tell apart from
// an account that truly has no window, and a failed read is the only non-destructive reading of it.
function describeUnreadableUsageResponse(data: unknown): string {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return 'Claude usage response was not a usage reading'
  }
  return namesReadableUsageField(data, USAGE_RESPONSE_KEYS)
    ? 'Claude usage response had a usage field Orca could not read'
    : 'Claude usage response contained no usage window'
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
    const response = await net.fetch(OAUTH_USAGE_URL, {
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

    const data: unknown = await response.json()
    if (signal?.aborted) {
      return abortedClaudeRateLimitResult()
    }
    if (!isReadableUsageBody(data)) {
      throw new OAuthUsageUnreadableError(describeUnreadableUsageResponse(data))
    }
    const body = data as OAuthUsageResponse
    const session = mapClaudeUsageWindow(body.five_hour, 300)
    const weekly = mapClaudeUsageWindow(body.seven_day, 10080)
    const fableWeekly = mapFableWeeklyWindow(body)
    if (!session && !weekly && !fableWeekly) {
      throw new OAuthUsageUnreadableError(describeUnreadableUsageResponse(data))
    }
    return {
      provider: 'claude',
      session,
      weekly,
      fableWeekly,
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
