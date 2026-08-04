import { net } from 'electron'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { loadProjectId, refreshAccessToken, type RefreshTokenResult } from './gemini-oauth-sources'
import type { MemorySnapshot } from '../../shared/memory-snapshot'
import {
  getGeminiOAuthPreparationSnapshot,
  hydrateGeminiOAuthPreparationSnapshot,
  commitGeminiOAuthTokenRefresh,
  type GeminiOAuthPreparation
} from './gemini-oauth-preparation-snapshot'
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
  preparation: Extract<GeminiOAuthPreparation, { source: 'auth-json' }>
): Promise<ProviderRateLimits> {
  const auth = preparation.auth
  let accessToken = auth.access
  const refreshToken = (auth.refresh || '').split('|')[0] ?? ''
  if (auth.expires < Date.now() || !accessToken) {
    const refreshResult = await refreshPreparedToken(preparation, refreshToken)
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
    const refreshResult = await refreshPreparedToken(preparation, refreshToken)
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
  preparation: Extract<GeminiOAuthPreparation, { source: 'oauth-creds' }>
): Promise<ProviderRateLimits> {
  const creds = preparation.credentials
  let accessToken = creds.access_token
  let currentCreds = creds
  if (creds.expiry_date < Date.now()) {
    const refreshResult = await refreshPreparedToken(preparation, creds.refresh_token)
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
    const refreshResult = await refreshPreparedToken(preparation, currentCreds.refresh_token)
    if (refreshResult?.accessToken) {
      const newProjectId = await loadProjectId(refreshResult.accessToken).catch(() => {
        return ''
      })
      if (newProjectId) {
        return fetchQuota(refreshResult.accessToken, newProjectId)
      }
    }
  }
  return result
}

async function refreshPreparedToken(
  preparation: GeminiOAuthPreparation,
  refreshToken: string
): Promise<RefreshTokenResult | null> {
  if (!preparation.clientCredentials) {
    return null
  }
  const result = await refreshAccessToken(
    refreshToken,
    preparation.clientCredentials.clientId,
    preparation.clientCredentials.clientSecret
  )
  await commitGeminiOAuthTokenRefresh(preparation, result)
  return result
}

function unavailableResult(error: string): ProviderRateLimits {
  return {
    provider: 'gemini',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status: 'unavailable'
  }
}

function credentialReadError(error: string): ProviderRateLimits {
  return {
    ...unavailableResult(error),
    status: 'error',
    usageMetadata: { failureKind: 'keychain-unavailable', source: 'oauth' }
  }
}

export async function fetchGeminiRateLimits(
  geminiCliOAuthEnabled: boolean,
  snapshot: MemorySnapshot<GeminiOAuthPreparation>
): Promise<ProviderRateLimits> {
  if (!geminiCliOAuthEnabled) {
    // Why: the OAuth sources include other apps' data folders on macOS.
    // Do not touch them during background polling unless the user opts in.
    return unavailableResult('Gemini CLI OAuth is disabled in settings')
  }
  if (snapshot.stale || snapshot.availability === 'denied') {
    return credentialReadError('Gemini credential snapshot is stale; refresh to retry')
  }
  if (snapshot.availability === 'unavailable') {
    return credentialReadError('Gemini credential snapshot is unavailable; refresh to retry')
  }
  if (snapshot.availability !== 'ready' || !snapshot.value) {
    return unavailableResult(
      snapshot.availability === 'missing'
        ? 'Gemini CLI credentials not found'
        : 'Gemini credential snapshot is unavailable; refresh to retry'
    )
  }

  try {
    return snapshot.value.source === 'auth-json'
      ? await fetchViaAuthJson(snapshot.value)
      : await fetchViaOauthCreds(snapshot.value)
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

export async function fetchGeminiRateLimitsWithHydration(
  geminiCliOAuthEnabled = false
): Promise<ProviderRateLimits> {
  await hydrateGeminiOAuthPreparationSnapshot(geminiCliOAuthEnabled)
  return fetchGeminiRateLimits(geminiCliOAuthEnabled, getGeminiOAuthPreparationSnapshot())
}
