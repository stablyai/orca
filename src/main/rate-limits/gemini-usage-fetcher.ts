import { net } from 'electron'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  loadProjectId,
  readAuthJson,
  readGeminiCredentials,
  saveGeminiCredentials,
  tryRefreshTokenFromBundle,
  type GeminiCredentials,
  type GoogleAuthEntry
} from './gemini-oauth-sources'
import {
  buildRateLimitBucket,
  deduplicateBuckets,
  deriveSessionSummary
} from './gemini-bucket-formatting'

const API_TIMEOUT_MS = 10_000
const RETRIEVE_QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota'

type QuotaBucket = { remainingFraction: number; resetTime: string; modelId: string }

function isQuotaBucket(o: unknown): o is QuotaBucket {
  return (
    typeof o === 'object' &&
    o !== null &&
    typeof (o as QuotaBucket).remainingFraction === 'number' &&
    Number.isFinite((o as QuotaBucket).remainingFraction) &&
    typeof (o as QuotaBucket).resetTime === 'string' &&
    typeof (o as QuotaBucket).modelId === 'string'
  )
}

function parseQuotaResponse(data: unknown): QuotaBucket[] {
  let rawBuckets: unknown[] = []
  if (Array.isArray(data)) {
    rawBuckets = data
  } else if (data && typeof data === 'object' && 'buckets' in data && Array.isArray(data.buckets)) {
    rawBuckets = data.buckets
  }
  return rawBuckets.filter((b) => isQuotaBucket(b))
}

async function fetchQuota(accessToken: string, projectId: string): Promise<ProviderRateLimits> {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, API_TIMEOUT_MS)
  try {
    const res = await net.fetch(RETRIEVE_QUOTA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ project: projectId }),
      signal: controller.signal
    })
    if (!res.ok) {
      return {
        provider: 'gemini',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: `Quota fetch failed (${res.status})`,
        status: 'error'
      }
    }
    const data = (await res.json()) as unknown
    const buckets = deduplicateBuckets(
      parseQuotaResponse(data).map((b) => ({ ...buildRateLimitBucket(b), modelId: b.modelId }))
    )
    return {
      provider: 'gemini',
      session: deriveSessionSummary(buckets),
      weekly: null,
      buckets,
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchViaAuthJson(
  auth: GoogleAuthEntry,
  geminiCliOAuthEnabled = false
): Promise<ProviderRateLimits> {
  let accessToken = auth.access
  const refreshToken = (auth.refresh || '').split('|')[0] ?? ''
  if (auth.expires < Date.now() || !accessToken) {
    const refreshResult = await tryRefreshTokenFromBundle(refreshToken, geminiCliOAuthEnabled)
    if (!refreshResult?.accessToken) {
      return {
        provider: 'gemini',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: 'Token refresh failed',
        status: 'error'
      }
    }
    accessToken = refreshResult.accessToken
  }
  let effectiveProjectId = ''
  try {
    effectiveProjectId = await loadProjectId(accessToken)
  } catch {
    effectiveProjectId =
      (auth.refresh || '').split('|')[1] || (auth.refresh || '').split('|')[2] || ''
  }
  if (!effectiveProjectId) {
    return {
      provider: 'gemini',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'Gemini project ID not found',
      status: 'error'
    }
  }
  const result = await fetchQuota(accessToken, effectiveProjectId)
  if (result.status === 'error' && result.error?.includes('401')) {
    const refreshResult = await tryRefreshTokenFromBundle(refreshToken, geminiCliOAuthEnabled)
    if (refreshResult?.accessToken) {
      const newProjectId = await loadProjectId(refreshResult.accessToken).catch(() => {
        return effectiveProjectId
      })
      return fetchQuota(refreshResult.accessToken, newProjectId)
    }
  }
  return result
}

async function fetchViaOauthCreds(
  creds: GeminiCredentials,
  geminiCliOAuthEnabled = false
): Promise<ProviderRateLimits> {
  let accessToken = creds.access_token
  let currentCreds = creds
  if (creds.expiry_date < Date.now()) {
    const refreshResult = await tryRefreshTokenFromBundle(
      creds.refresh_token,
      geminiCliOAuthEnabled
    )
    if (!refreshResult?.accessToken) {
      return {
        provider: 'gemini',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: 'Token refresh failed',
        status: 'error'
      }
    }
    accessToken = refreshResult.accessToken
    currentCreds = {
      ...creds,
      access_token: accessToken,
      expiry_date: refreshResult.expiresIn
        ? Date.now() + refreshResult.expiresIn * 1000
        : creds.expiry_date
    }
    await saveGeminiCredentials(currentCreds)
  }
  const projectId = await loadProjectId(accessToken).catch(() => {
    return ''
  })
  if (!projectId) {
    return {
      provider: 'gemini',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'Gemini project ID not found',
      status: 'error'
    }
  }
  const result = await fetchQuota(accessToken, projectId)
  if (result.status === 'error' && result.error?.includes('401')) {
    const refreshResult = await tryRefreshTokenFromBundle(
      currentCreds.refresh_token,
      geminiCliOAuthEnabled
    )
    if (refreshResult?.accessToken) {
      const newProjectId = await loadProjectId(refreshResult.accessToken).catch(() => {
        return ''
      })
      if (newProjectId) {
        await saveGeminiCredentials({
          ...currentCreds,
          access_token: refreshResult.accessToken,
          expiry_date: refreshResult.expiresIn
            ? Date.now() + refreshResult.expiresIn * 1000
            : currentCreds.expiry_date
        })
        return fetchQuota(refreshResult.accessToken, newProjectId)
      }
    }
  }
  return result
}

export async function fetchGeminiRateLimits(
  geminiCliOAuthEnabled = false
): Promise<ProviderRateLimits> {
  if (!geminiCliOAuthEnabled) {
    // Why: the OAuth sources include other apps' data folders on macOS.
    // Do not touch them during background polling unless the user opts in.
    return {
      provider: 'gemini',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'Gemini CLI OAuth is disabled in settings',
      status: 'unavailable'
    }
  }

  try {
    const authJson = await readAuthJson()
    const result =
      authJson?.google?.type === 'oauth'
        ? await fetchViaAuthJson(authJson.google, geminiCliOAuthEnabled)
        : await (async () => {
            const creds = await readGeminiCredentials()
            return !creds
              ? ({
                  provider: 'gemini',
                  session: null,
                  weekly: null,
                  updatedAt: Date.now(),
                  error: 'Gemini CLI credentials not found',
                  status: 'unavailable'
                } as ProviderRateLimits)
              : await fetchViaOauthCreds(creds, geminiCliOAuthEnabled)
          })()
    return result
  } catch (err) {
    return {
      provider: 'gemini',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: err instanceof Error ? err.message : 'Unknown error',
      status: 'error'
    }
  }
}
