import { net } from 'electron'
import type {
  ProviderRateLimits,
  RateLimitBucket,
  RateLimitWindow
} from '../../shared/rate-limit-types'
import {
  loadProjectId,
  readAuthJson,
  readGeminiCredentials,
  saveGeminiCredentials,
  tryRefreshTokenFromBundle,
  type GeminiCredentials,
  type GoogleAuthEntry
} from './gemini-oauth-sources'

const API_TIMEOUT_MS = 10_000
const RETRIEVE_QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota'
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

// ── In-memory cache for credentials to avoid redundant I/O ────────────
let cachedCreds: { data: ProviderRateLimits; timestamp: number } | null = null

type QuotaBucket = {
  remainingFraction: number
  resetTime: string
  modelId: string
}

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

const MODEL_ID_TO_BUCKET_NAME: Record<string, string> = {
  'gemini-2.5-pro': 'Pro',
  'gemini-2.5-flash': 'Flash',
  'gemini-2.5-flash-lite': 'Flash Lite',
  'gemini-2.0-pro': '2.0 Pro',
  'gemini-2.0-flash': '2.0 Flash',
  'gemini-2.0-flash-lite': '2.0 Flash Lite',
  'gemini-1.5-pro': '1.5 Pro',
  'gemini-1.5-flash': '1.5 Flash',
  'gemini-exp': 'Exp',
  'gemini-experimental': 'Exp'
}

function humanizeModelId(modelId: string): string {
  const withoutPrefix = modelId.replace(/^gemini-/i, '')
  return withoutPrefix
    .split('-')
    .map((part) => (part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(' ')
}

export function getBucketName(modelId: string): string {
  return MODEL_ID_TO_BUCKET_NAME[modelId] ?? humanizeModelId(modelId)
}

const GEMINI_BUCKET_WINDOW_MINUTES = 60

function buildRateLimitBucket(b: QuotaBucket): RateLimitBucket {
  const usedPercent = Math.min(100, Math.max(0, Math.round((1 - b.remainingFraction) * 100)))
  const resetsAtTime = new Date(b.resetTime).getTime()
  return {
    name: getBucketName(b.modelId),
    usedPercent,
    windowMinutes: GEMINI_BUCKET_WINDOW_MINUTES,
    resetsAt: !isNaN(resetsAtTime) ? resetsAtTime : null,
    resetDescription: null
  }
}

export function deriveSessionSummary(buckets: RateLimitBucket[]): RateLimitWindow | null {
  if (buckets.length === 0) {
    return null
  }
  const mostConstrained = buckets.reduce((worst, bucket) =>
    bucket.usedPercent > worst.usedPercent ? bucket : worst
  )
  const { name: _name, ...window } = mostConstrained
  return window
}

async function fetchQuota(accessToken: string, projectId: string): Promise<ProviderRateLimits> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS)

  try {
    const res = await net.fetch(RETRIEVE_QUOTA_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      },
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
    const buckets = parseQuotaResponse(data).map(buildRateLimitBucket)
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

async function fetchViaAuthJson(auth: GoogleAuthEntry): Promise<ProviderRateLimits> {
  let accessToken = auth.access
  const refreshToken = (auth.refresh || '').split('|')[0] ?? ''

  if (auth.expires < Date.now() || !accessToken) {
    const refreshResult = await tryRefreshTokenFromBundle(refreshToken)
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

  // Why: auth.json might have stale project IDs. loadProjectId provides a
  // more robust way to resolve the active project for the current token.
  let effectiveProjectId = ''
  try {
    effectiveProjectId = await loadProjectId(accessToken)
  } catch {
    // Fallback to split-pipe ID if loadProjectId fails
    effectiveProjectId = (auth.refresh || '').split('|')[1] || (auth.refresh || '').split('|')[2]
  }

  if (!effectiveProjectId) {
    return {
      provider: 'gemini',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'Gemini project ID not found in auth.json',
      status: 'error'
    }
  }

  const result = await fetchQuota(accessToken, effectiveProjectId)
  if (result.status === 'error' && result.error?.includes('401')) {
    const refreshResult = await tryRefreshTokenFromBundle(refreshToken)
    if (refreshResult?.accessToken) {
      const newProjectId = await loadProjectId(refreshResult.accessToken).catch(
        () => effectiveProjectId
      )
      return fetchQuota(refreshResult.accessToken, newProjectId)
    }
  }

  return result
}

async function fetchViaOauthCreds(creds: GeminiCredentials): Promise<ProviderRateLimits> {
  let accessToken = creds.access_token
  let currentCreds = creds

  if (creds.expiry_date < Date.now()) {
    const refreshResult = await tryRefreshTokenFromBundle(creds.refresh_token)
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

  let projectId = ''
  try {
    projectId = await loadProjectId(accessToken)
  } catch {
    projectId = ''
  }

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
    const refreshResult = await tryRefreshTokenFromBundle(currentCreds.refresh_token)
    if (refreshResult?.accessToken) {
      projectId = await loadProjectId(refreshResult.accessToken).catch(() => '')
      if (projectId) {
        await saveGeminiCredentials({
          ...currentCreds,
          access_token: refreshResult.accessToken,
          expiry_date: refreshResult.expiresIn
            ? Date.now() + refreshResult.expiresIn * 1000
            : currentCreds.expiry_date
        })
        return fetchQuota(refreshResult.accessToken, projectId)
      }
    }
  }

  return result
}

export async function fetchGeminiRateLimits(force = false): Promise<ProviderRateLimits> {
  if (!force && cachedCreds && Date.now() - cachedCreds.timestamp < CACHE_TTL_MS) {
    return cachedCreds.data
  }

  try {
    const authJson = await readAuthJson()
    let result: ProviderRateLimits

    if (authJson?.google?.type === 'oauth') {
      result = await fetchViaAuthJson(authJson.google)
    } else {
      const creds = await readGeminiCredentials()
      result = !creds
        ? {
            provider: 'gemini',
            session: null,
            weekly: null,
            updatedAt: Date.now(),
            error: 'Gemini CLI credentials not found',
            status: 'unavailable'
          }
        : await fetchViaOauthCreds(creds)
    }

    if (result.status !== 'error') {
      cachedCreds = { data: result, timestamp: Date.now() }
    }
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
