import { net } from 'electron'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  extractAntigravityOAuthClients,
  type AntigravityOAuthClient
} from './antigravity-cli-oauth-extractor'
import { parseAntigravityQuotaSummary } from './antigravity-quota-summary'
import { refreshAccessToken } from './gemini-oauth-sources'
import {
  isAntigravityAccessTokenFresh,
  readAntigravityAuthSession,
  readAntigravityDefaultProjectId,
  saveAntigravityCredentials,
  type AntigravityAuthSession
} from './antigravity-oauth-sources'

const API_TIMEOUT_MS = 10_000
const QUOTA_SUMMARY_URLS = [
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary'
] as const

const LICENSE_UNAVAILABLE_REASON =
  'Antigravity CLI is signed in. Orca could not read a Code Assist quota for this account.'

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

function isLicenseRefusal(message: string): boolean {
  return /valid license of this product/i.test(message)
}

function quotaHeaders(accessToken: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': 'antigravity'
  }
}

async function fetchQuotaSummary(accessToken: string, projectId: string | null): Promise<Response> {
  const body = JSON.stringify(projectId ? { project: projectId } : {})
  let last: Response | undefined
  for (const url of QUOTA_SUMMARY_URLS) {
    const response = await net.fetch(url, {
      method: 'POST',
      headers: quotaHeaders(accessToken),
      body,
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    })
    last = response
    if (response.ok || response.status === 401 || response.status < 500) {
      return response
    }
  }
  return last!
}

async function refreshSession(
  session: AntigravityAuthSession,
  clients: AntigravityOAuthClient[]
): Promise<AntigravityAuthSession | null> {
  const refreshToken = session.refreshToken
  if (!refreshToken) {
    return null
  }
  for (const client of clients) {
    const refreshed = await refreshAccessToken(refreshToken, client.clientId, client.clientSecret)
    if (!refreshed.accessToken) {
      continue
    }
    const next: AntigravityAuthSession = {
      ...session,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.newRefreshToken ?? refreshToken,
      expiresAtMs: refreshed.expiresIn
        ? Date.now() + refreshed.expiresIn * 1000
        : session.expiresAtMs
    }
    await saveAntigravityCredentials(next)
    return next
  }
  return null
}

async function ensureFreshSession(
  session: AntigravityAuthSession,
  forceRefresh: boolean
): Promise<AntigravityAuthSession | null> {
  if (!forceRefresh && isAntigravityAccessTokenFresh(session)) {
    return session
  }
  const clients = await extractAntigravityOAuthClients()
  return refreshSession(session, clients)
}

export async function fetchAntigravityRateLimits(): Promise<ProviderRateLimits> {
  const auth = readAntigravityAuthSession()
  if (auth.status === 'missing') {
    return result('unavailable', 'Antigravity CLI is not signed in')
  }
  if (auth.status === 'error') {
    return result('error', auth.error, {
      usageMetadata: { failureKind: 'parse', source: 'oauth' }
    })
  }

  let session = await ensureFreshSession(auth.session, false)
  if (!session?.accessToken) {
    return result(
      'error',
      'Antigravity session expired. Run agy on this computer to refresh sign-in.',
      { usageMetadata: { failureKind: 'stale-token', source: 'oauth' } }
    )
  }

  try {
    const projectId = await readAntigravityDefaultProjectId()
    let response = await fetchQuotaSummary(session.accessToken, projectId)
    if (response.status === 401) {
      const refreshed = await ensureFreshSession(session, true)
      if (!refreshed?.accessToken) {
        return result(
          'error',
          'Antigravity session expired. Run agy on this computer to refresh sign-in.',
          { usageMetadata: { failureKind: 'stale-token', source: 'oauth' } }
        )
      }
      session = refreshed
      response = await fetchQuotaSummary(session.accessToken, projectId)
    }
    if (!response.ok) {
      const body = await response.text()
      if (response.status === 403 && isLicenseRefusal(body)) {
        return result('unavailable', LICENSE_UNAVAILABLE_REASON, {
          usageMetadata: { failureKind: 'usage-unavailable', source: 'oauth' }
        })
      }
      return result('error', `Quota fetch failed (${response.status})`, {
        usageMetadata: { failureKind: response.status === 401 ? 'stale-token' : 'server' }
      })
    }
    const parsed = parseAntigravityQuotaSummary((await response.json()) as unknown)
    if (!parsed) {
      return result(
        'unavailable',
        'Antigravity CLI is signed in. Orca could not read a usage percentage for this account.',
        { usageMetadata: { failureKind: 'usage-unavailable', source: 'oauth' } }
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
  } catch (err) {
    return result('error', err instanceof Error ? err.message : 'Unknown error', {
      usageMetadata: { failureKind: 'network' }
    })
  }
}
