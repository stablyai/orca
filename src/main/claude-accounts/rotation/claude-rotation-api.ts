import { getMainHttpClient } from '../../network/http-client'
import { abortSignalWithTimeout } from '../../lib/abort-signal-with-timeout'
import { fetchClaudeOAuthUsage } from '../../rate-limits/providers/claude/claude-oauth-usage-request'
import { OAuthUsageError } from '../../rate-limits/providers/claude/claude-oauth-usage-error'
import { isRecord } from './claude-rotation-keychain'
import { rotationUsageFromRateLimits, type RotationUsage } from './claude-rotation-policy'

const OAUTH_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'

export type RotationUsageFetch =
  | { status: 'ok'; usage: RotationUsage }
  | { status: 'rate-limited' }
  | { status: 'failed' }

/** Reads only; the rotation never calls a token refresh endpoint. */
export async function fetchRotationUsage(accessToken: string): Promise<RotationUsageFetch> {
  try {
    const limits = await fetchClaudeOAuthUsage(accessToken)
    return limits.status === 'ok'
      ? { status: 'ok', usage: rotationUsageFromRateLimits(limits) }
      : { status: 'failed' }
  } catch (error) {
    return error instanceof OAuthUsageError && error.status === 429
      ? { status: 'rate-limited' }
      : { status: 'failed' }
  }
}

/** First 8 characters of the token's account uuid, as the external script records it. */
export async function fetchClaudeAccountOfToken(accessToken: string): Promise<string | null> {
  try {
    const response = await getMainHttpClient().fetch(OAUTH_PROFILE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json'
      },
      signal: abortSignalWithTimeout(undefined, 10_000)
    })
    if (!response.ok) {
      return null
    }
    const body: unknown = await response.json()
    const uuid = isRecord(body) && isRecord(body.account) ? body.account.uuid : null
    return typeof uuid === 'string' && uuid ? uuid.slice(0, 8) : null
  } catch {
    return null
  }
}
