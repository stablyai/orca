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
  tryRefreshTokenFromBundle,
  type GeminiCredentials,
  type GoogleAuthEntry
} from './gemini-oauth-sources'

const API_TIMEOUT_MS = 10_000
const RETRIEVE_QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota'

type QuotaBucket = {
  remainingFraction: number
  resetTime: string
  modelId: string
}

function parseQuotaResponse(data: unknown): QuotaBucket[] {
  if (Array.isArray(data)) {
    return data as QuotaBucket[]
  }
  if (data && typeof data === 'object' && 'buckets' in data && Array.isArray(data.buckets)) {
    return data.buckets as QuotaBucket[]
  }
  return []
}

// Model ID mapping
const MODEL_ID_TO_BUCKET_NAME: Record<string, string> = {
  'gemini-2.5-pro': 'Pro',
  'gemini-2.5-flash': 'Flash',
  'gemini-2.0-flash-lite': 'Flash Lite'
}

export function getBucketName(modelId: string): string {
  return MODEL_ID_TO_BUCKET_NAME[modelId] ?? `Unknown (${modelId})`
}

function buildRateLimitBucket(b: QuotaBucket): RateLimitBucket {
  const usedPercent = Math.min(100, Math.max(0, Math.round((1 - b.remainingFraction) * 100)))

  const resetsAtTime = new Date(b.resetTime).getTime()
  const resetsAt = !isNaN(resetsAtTime) ? resetsAtTime : null
  const windowMinutes = resetsAt !== null ? Math.round((resetsAt - Date.now()) / 60000) : 60

  return {
    name: getBucketName(b.modelId),
    usedPercent,
    windowMinutes,
    resetsAt,
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
    const session = deriveSessionSummary(buckets)

    return {
      provider: 'gemini',
      session,
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

  const refreshParts = auth.refresh.split('|')
  const projectId = refreshParts[1] ?? ''
  const managedProjectId = refreshParts[2] ?? ''
  const effectiveProjectId = projectId || managedProjectId

  if (auth.expires < Date.now()) {
    return {
      provider: 'gemini',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'Token refresh unavailable for auth.json source',
      status: 'error'
    }
  }

  const result = await fetchQuota(accessToken, effectiveProjectId)

  // Why: auth.json gives us project metadata but not a safe refresh path inside
  // Orca, so a rejected token must fail closed instead of embedding secrets.
  if (result.status === 'error' && result.error?.includes('Quota fetch failed (401)')) {
    return {
      provider: 'gemini',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'Token refresh unavailable for auth.json source',
      status: 'error'
    }
  }

  return result
}

async function fetchViaOauthCreds(creds: GeminiCredentials): Promise<ProviderRateLimits> {
  let accessToken = creds.access_token

  if (creds.expiry_date < Date.now()) {
    const newToken = await tryRefreshTokenFromBundle(creds)
    if (!newToken) {
      return {
        provider: 'gemini',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: 'Token refresh failed',
        status: 'error'
      }
    }
    accessToken = newToken
  }

  let projectId = ''
  try {
    projectId = await loadProjectId(accessToken)
  } catch {
    projectId = ''
  }

  let result = await fetchQuota(accessToken, projectId)

  // Why: server may reject tokens early even when expiry_date is valid locally.
  if (result.status === 'error' && result.error?.includes('Quota fetch failed (401)')) {
    const newToken = await tryRefreshTokenFromBundle(creds)
    if (!newToken) {
      return {
        provider: 'gemini',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: 'Token refresh failed',
        status: 'error'
      }
    }
    accessToken = newToken

    try {
      projectId = await loadProjectId(accessToken)
    } catch {
      projectId = ''
    }

    result = await fetchQuota(accessToken, projectId)
  }

  return result
}

export async function fetchGeminiRateLimits(): Promise<ProviderRateLimits> {
  try {
    const authJson = await readAuthJson()
    if (authJson?.google?.type === 'oauth') {
      return await fetchViaAuthJson(authJson.google)
    }

    const creds = await readGeminiCredentials()
    if (!creds) {
      return {
        provider: 'gemini',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: 'Gemini CLI credentials not found',
        status: 'unavailable'
      }
    }

    return await fetchViaOauthCreds(creds)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return {
      provider: 'gemini',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: message,
      status: 'error'
    }
  }
}
