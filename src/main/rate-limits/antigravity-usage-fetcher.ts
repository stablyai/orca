import { net } from 'electron'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  isAntigravityAccessTokenFresh,
  readAntigravityAuthSession,
  type AntigravityAuthSession
} from './antigravity-oauth-sources'
import { parseAntigravityQuotaSummary } from './antigravity-quota-summary'
import { tryRefreshTokenFromBundle } from './gemini-oauth-sources'

const API_TIMEOUT_MS = 10_000
const QUOTA_SUMMARY_URLS = [
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary'
] as const

export const ANTIGRAVITY_NOT_SIGNED_IN =
  'Antigravity is not signed in on this computer. Sign in with agy, then refresh usage.'
export const ANTIGRAVITY_SESSION_EXPIRED =
  'Antigravity session expired. Run agy on this computer to refresh sign-in.'

function result(
  status: ProviderRateLimits['status'],
  error: string | null,
  extras: Partial<ProviderRateLimits> = {}
): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: extras.session ?? null,
    weekly: extras.weekly ?? null,
    buckets: extras.buckets,
    updatedAt: Date.now(),
    error,
    status,
    usageMetadata: extras.usageMetadata
  }
}

async function ensureFreshSession(
  session: AntigravityAuthSession
): Promise<AntigravityAuthSession | null> {
  if (isAntigravityAccessTokenFresh(session)) {
    return session
  }
  if (!session.refreshToken) {
    return null
  }
  const refreshed = await tryRefreshTokenFromBundle(session.refreshToken, true)
  if (!refreshed?.accessToken) {
    return null
  }
  return {
    ...session,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.newRefreshToken ?? session.refreshToken,
    expiresAtMs: refreshed.expiresIn ? Date.now() + refreshed.expiresIn * 1000 : session.expiresAtMs
  }
}

async function fetchQuotaSummary(accessToken: string): Promise<Response | null> {
  let last: Response | null = null
  for (const url of QUOTA_SUMMARY_URLS) {
    const response = await net.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'antigravity'
      },
      body: '{}',
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    })
    last = response
    if (response.ok || response.status === 401 || response.status < 500) {
      return response
    }
  }
  return last
}

export async function fetchAntigravityRateLimits(): Promise<ProviderRateLimits> {
  const auth = await readAntigravityAuthSession()
  if (auth.status === 'missing') {
    return result('unavailable', ANTIGRAVITY_NOT_SIGNED_IN, {
      usageMetadata: { source: 'oauth', failureKind: 'missing-credentials' }
    })
  }
  if (auth.status === 'error') {
    return result('error', auth.error, {
      usageMetadata: { source: 'oauth', failureKind: 'parse' }
    })
  }

  let session = await ensureFreshSession(auth.session)
  if (!session?.accessToken) {
    return result('error', ANTIGRAVITY_SESSION_EXPIRED, {
      usageMetadata: { source: 'oauth', failureKind: 'stale-token' }
    })
  }

  try {
    let response = await fetchQuotaSummary(session.accessToken)
    if (response?.status === 401) {
      session = await ensureFreshSession({ ...session, accessToken: null })
      if (!session?.accessToken) {
        return result('error', ANTIGRAVITY_SESSION_EXPIRED, {
          usageMetadata: { source: 'oauth', failureKind: 'stale-token' }
        })
      }
      response = await fetchQuotaSummary(session.accessToken)
    }
    if (!response) {
      return result('error', 'Quota fetch failed', {
        usageMetadata: { source: 'oauth', failureKind: 'network' }
      })
    }
    if (!response.ok) {
      return result('error', `Quota fetch failed (${response.status})`, {
        usageMetadata: {
          source: 'oauth',
          failureKind: response.status === 401 ? 'stale-token' : 'server'
        }
      })
    }
    const parsed = parseAntigravityQuotaSummary((await response.json()) as unknown)
    if (!parsed) {
      return result(
        'unavailable',
        'Antigravity is signed in. Orca could not read a usage percentage for this account.',
        { usageMetadata: { source: 'oauth', failureKind: 'usage-unavailable' } }
      )
    }
    return {
      provider: 'antigravity',
      session: parsed.session,
      weekly: parsed.weekly,
      buckets: parsed.buckets,
      updatedAt: Date.now(),
      error: null,
      status: 'ok',
      usageMetadata: { source: 'oauth' }
    }
  } catch (error) {
    return result('error', error instanceof Error ? error.message : 'Unknown error', {
      usageMetadata: { source: 'oauth', failureKind: 'network' }
    })
  }
}
