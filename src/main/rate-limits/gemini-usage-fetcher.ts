import { abortSignalWithTimeout } from '../lib/abort-signal-with-timeout'
import { getMainHttpClient } from '../network/http-client'
import type { ProviderRateLimits, UsageRateLimitFailureKind } from '../../shared/rate-limit-types'
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
import { classifyThrownUsageRequestError } from './usage-request-failure-kind'

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

function geminiError(err: unknown, failureKind?: UsageRateLimitFailureKind): ProviderRateLimits {
  return {
    provider: 'gemini',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: err instanceof Error ? err.message : 'Unknown error',
    status: 'error',
    ...(failureKind ? { usageMetadata: { failureKind } } : {})
  }
}

async function fetchQuota(
  accessToken: string,
  projectId: string,
  signal?: AbortSignal
): Promise<ProviderRateLimits> {
  signal?.throwIfAborted()
  try {
    const res = await getMainHttpClient().fetch(RETRIEVE_QUOTA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ project: projectId }),
      signal: abortSignalWithTimeout(signal, API_TIMEOUT_MS)
    })
    signal?.throwIfAborted()
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
    signal?.throwIfAborted()
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
  } catch (err) {
    signal?.throwIfAborted()
    return geminiError(err, classifyThrownUsageRequestError(err))
  }
}

async function fetchViaAuthJson(
  auth: GoogleAuthEntry,
  geminiCliOAuthEnabled = false,
  signal?: AbortSignal
): Promise<ProviderRateLimits> {
  signal?.throwIfAborted()
  let accessToken = auth.access
  const refreshToken = (auth.refresh || '').split('|')[0] ?? ''
  if (auth.expires < Date.now() || !accessToken) {
    const refreshResult = await tryRefreshTokenFromBundle(
      refreshToken,
      geminiCliOAuthEnabled,
      signal
    )
    signal?.throwIfAborted()
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
    effectiveProjectId = await loadProjectId(accessToken, signal)
  } catch {
    signal?.throwIfAborted()
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
  const result = await fetchQuota(accessToken, effectiveProjectId, signal)
  signal?.throwIfAborted()
  if (result.status === 'error' && result.error?.includes('401')) {
    const refreshResult = await tryRefreshTokenFromBundle(
      refreshToken,
      geminiCliOAuthEnabled,
      signal
    )
    signal?.throwIfAborted()
    if (refreshResult?.accessToken) {
      const newProjectId = await loadProjectId(refreshResult.accessToken, signal).catch(() => {
        signal?.throwIfAborted()
        return effectiveProjectId
      })
      return fetchQuota(refreshResult.accessToken, newProjectId, signal)
    }
  }
  return result
}

async function fetchViaOauthCreds(
  creds: GeminiCredentials,
  geminiCliOAuthEnabled = false,
  signal?: AbortSignal
): Promise<ProviderRateLimits> {
  signal?.throwIfAborted()
  let accessToken = creds.access_token
  let currentCreds = creds
  if (creds.expiry_date < Date.now()) {
    const refreshResult = await tryRefreshTokenFromBundle(
      creds.refresh_token,
      geminiCliOAuthEnabled,
      signal
    )
    signal?.throwIfAborted()
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
    await saveGeminiCredentials(currentCreds, signal)
  }
  const projectId = await loadProjectId(accessToken, signal).catch(() => {
    signal?.throwIfAborted()
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
  const result = await fetchQuota(accessToken, projectId, signal)
  signal?.throwIfAborted()
  if (result.status === 'error' && result.error?.includes('401')) {
    const refreshResult = await tryRefreshTokenFromBundle(
      currentCreds.refresh_token,
      geminiCliOAuthEnabled,
      signal
    )
    signal?.throwIfAborted()
    if (refreshResult?.accessToken) {
      const newProjectId = await loadProjectId(refreshResult.accessToken, signal).catch(() => {
        signal?.throwIfAborted()
        return ''
      })
      if (newProjectId) {
        await saveGeminiCredentials(
          {
            ...currentCreds,
            access_token: refreshResult.accessToken,
            expiry_date: refreshResult.expiresIn
              ? Date.now() + refreshResult.expiresIn * 1000
              : currentCreds.expiry_date
          },
          signal
        )
        return fetchQuota(refreshResult.accessToken, newProjectId, signal)
      }
    }
  }
  return result
}

export async function fetchGeminiRateLimits(
  geminiCliOAuthEnabled = false,
  signal?: AbortSignal
): Promise<ProviderRateLimits> {
  signal?.throwIfAborted()
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
    const authJson = await readAuthJson(signal)
    signal?.throwIfAborted()
    const result =
      authJson?.google?.type === 'oauth'
        ? await fetchViaAuthJson(authJson.google, geminiCliOAuthEnabled, signal)
        : await (async () => {
            const creds = await readGeminiCredentials(signal)
            signal?.throwIfAborted()
            return !creds
              ? ({
                  provider: 'gemini',
                  session: null,
                  weekly: null,
                  updatedAt: Date.now(),
                  error: 'Gemini CLI credentials not found',
                  status: 'unavailable'
                } as ProviderRateLimits)
              : await fetchViaOauthCreds(creds, geminiCliOAuthEnabled, signal)
          })()
    return result
  } catch (err) {
    signal?.throwIfAborted()
    return geminiError(err)
  }
}
