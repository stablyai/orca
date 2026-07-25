import { net } from 'electron'
import { homedir } from 'node:os'
import type {
  ProviderRateLimits,
  RateLimitBucket,
  RateLimitWindow
} from '../../shared/rate-limit-types'
import { getValidAntigravityToken, refreshAntigravityToken } from './antigravity-auth'

const API_TIMEOUT = 10_000
const RETRIEVE_QUOTA_SUMMARY_URL =
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary'
const RETRIEVE_QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota'
const LOAD_CODE_ASSIST_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'

type RawQuotaBucket = {
  bucketId?: string
  modelId?: string
  remainingFraction?: number
  resetTime?: string
}

type QuotaGroup = {
  name?: string
  buckets?: RawQuotaBucket[]
}

const EXACT_BUCKET_MAP: Record<string, { name: string; windowMinutes: number }> = {
  'gemini-5h': { name: 'Gemini 5h', windowMinutes: 300 },
  'gemini-weekly': { name: 'Gemini weekly', windowMinutes: 10080 },
  '3p-5h': { name: 'Claude/GPT 5h', windowMinutes: 300 },
  '3p-weekly': { name: 'Claude/GPT weekly', windowMinutes: 10080 }
}

/**
 * Normalizes supported quota payloads while excluding unknown Antigravity bucket IDs.
 * @param data Untrusted quota response payload.
 * @returns Recognized quota buckets with their source bucket IDs.
 */
export function parseQuotaResponse(data: unknown): (RateLimitBucket & { bucketId: string })[] {
  let rawBuckets: RawQuotaBucket[] = []
  if (Array.isArray(data)) {
    rawBuckets = data as RawQuotaBucket[]
  } else if (data && typeof data === 'object') {
    const obj = data as { groups?: QuotaGroup[]; buckets?: RawQuotaBucket[] }
    if (Array.isArray(obj.groups)) {
      for (const g of obj.groups) {
        if (g && Array.isArray(g.buckets)) {
          rawBuckets.push(...g.buckets)
        }
      }
    } else if (Array.isArray(obj.buckets)) {
      rawBuckets = obj.buckets
    }
  }

  const result: (RateLimitBucket & { bucketId: string })[] = []
  for (const b of rawBuckets) {
    if (
      typeof b.remainingFraction === 'number' &&
      Number.isFinite(b.remainingFraction) &&
      typeof b.resetTime === 'string'
    ) {
      const bucketId = b.bucketId || b.modelId || ''
      const config = EXACT_BUCKET_MAP[bucketId]
      // Why: Skip unknown bucket IDs per OpenUsage exact allowlist to avoid polluting quota pools
      if (!config) {
        continue
      }
      const usedPercent = Math.min(100, Math.max(0, Math.round((1 - b.remainingFraction) * 100)))
      const resetsAt = new Date(b.resetTime).getTime()
      result.push({
        name: config.name,
        usedPercent,
        windowMinutes: config.windowMinutes,
        resetsAt: !Number.isNaN(resetsAt) ? resetsAt : null,
        resetDescription: null,
        bucketId
      })
    }
  }
  return result
}

/**
 * Selects the most-used five-hour and weekly buckets for legacy summary consumers.
 * @param buckets Normalized Antigravity quota buckets.
 * @returns Session and weekly summary windows.
 */
export function aggregateAntigravityWindows(buckets: (RateLimitBucket & { bucketId: string })[]): {
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
} {
  if (buckets.length === 0) {
    return { session: null, weekly: null }
  }

  const sessionBuckets = buckets.filter((b) => b.windowMinutes === 300)
  const targetSession = (sessionBuckets.length > 0 ? sessionBuckets : buckets).reduce((worst, b) =>
    b.usedPercent > worst.usedPercent ? b : worst
  )

  const weeklyBuckets = buckets.filter((b) => b.windowMinutes === 10080)
  const targetWeekly =
    weeklyBuckets.length > 0
      ? weeklyBuckets.reduce((worst, b) => (b.usedPercent > worst.usedPercent ? b : worst))
      : null

  const session: RateLimitWindow = {
    usedPercent: targetSession.usedPercent,
    windowMinutes: targetSession.windowMinutes,
    resetsAt: targetSession.resetsAt,
    resetDescription: targetSession.resetDescription
  }

  const weekly: RateLimitWindow | null = targetWeekly
    ? {
        usedPercent: targetWeekly.usedPercent,
        windowMinutes: targetWeekly.windowMinutes,
        resetsAt: targetWeekly.resetsAt,
        resetDescription: targetWeekly.resetDescription
      }
    : null

  return { session, weekly }
}

/**
 * Resolves the Cloud Code project associated with an Antigravity access token.
 * @param accessToken OAuth access token used for project discovery.
 * @returns The associated Cloud AI companion project ID.
 */
async function loadAntigravityProjectId(accessToken: string): Promise<string> {
  const res = await net.fetch(LOAD_CODE_ASSIST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY', pluginType: 'GEMINI' } }),
    signal: AbortSignal.timeout(API_TIMEOUT)
  })
  if (!res.ok) {
    const err = new Error(`Failed to load Antigravity project ID (HTTP ${res.status})`)
    Object.assign(err, { status: res.status })
    throw err
  }
  const data = (await res.json()) as { cloudaicompanionProject?: string }
  if (typeof data.cloudaicompanionProject !== 'string') {
    throw new Error('Antigravity project ID not found in API response')
  }
  return data.cloudaicompanionProject
}

/**
 * Queries the quota-summary endpoint with a legacy endpoint fallback.
 * @param accessToken OAuth access token used for quota requests.
 * @param projectId Cloud AI companion project ID.
 * @returns A normalized HTTP result and parsed response payload when successful.
 */
async function queryQuotaEndpoint(
  accessToken: string,
  projectId: string
): Promise<{ ok: boolean; status: number; data?: unknown }> {
  try {
    let res = await net.fetch(RETRIEVE_QUOTA_SUMMARY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ project: projectId }),
      signal: AbortSignal.timeout(API_TIMEOUT)
    })
    if (!res.ok) {
      res = await net.fetch(RETRIEVE_QUOTA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ project: projectId }),
        signal: AbortSignal.timeout(API_TIMEOUT)
      })
    }
    if (!res.ok) {
      return { ok: false, status: res.status }
    }
    return { ok: true, status: 200, data: await res.json() }
  } catch {
    return { ok: false, status: 500 }
  }
}

/**
 * Fetches independent Antigravity usage and retries the authenticated flow once on rejection.
 * @param antigravityEnabled Whether the provider is enabled.
 * @param baseHomedir Home directory used for credential discovery.
 * @returns The current Antigravity rate-limit state.
 */
export async function fetchAntigravityRateLimits(
  antigravityEnabled = true,
  baseHomedir = homedir()
): Promise<ProviderRateLimits> {
  if (!antigravityEnabled) {
    return {
      provider: 'antigravity',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'Antigravity OAuth is disabled in settings',
      status: 'unavailable'
    }
  }

  try {
    let token = await getValidAntigravityToken(baseHomedir)
    if (!token) {
      return {
        provider: 'antigravity',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: 'AGY credentials missing',
        status: 'unavailable'
      }
    }

    let isUnauthorized = false
    let projectId = ''
    try {
      projectId = await loadAntigravityProjectId(token.access_token)
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        'status' in err &&
        (err.status === 401 || err.status === 403)
      ) {
        isUnauthorized = true
      } else {
        return {
          provider: 'antigravity',
          session: null,
          weekly: null,
          updatedAt: Date.now(),
          error: 'AGY project ID not found',
          status: 'error'
        }
      }
    }

    let quotaRes = !isUnauthorized
      ? await queryQuotaEndpoint(token.access_token, projectId)
      : { ok: false, status: 401 }

    // Why: Unified 401/403 retry policy refreshes token and retries the full flow once if any authenticated call is rejected
    if (
      !quotaRes.ok &&
      (quotaRes.status === 401 || quotaRes.status === 403) &&
      token.refresh_token
    ) {
      const refreshed = await refreshAntigravityToken(token.refresh_token)
      if (refreshed) {
        token = refreshed
        projectId = await loadAntigravityProjectId(token.access_token).catch(() => '')
        if (projectId) {
          quotaRes = await queryQuotaEndpoint(token.access_token, projectId)
        }
      }
    }

    if (!quotaRes.ok || !quotaRes.data) {
      return {
        provider: 'antigravity',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: `AGY quota fetch failed (${quotaRes.status})`,
        status: 'error'
      }
    }

    const rawParsed = parseQuotaResponse(quotaRes.data)
    const { session, weekly } = aggregateAntigravityWindows(rawParsed)
    const buckets = rawParsed.map(({ bucketId: _b, ...rest }) => rest)

    return {
      provider: 'antigravity',
      session,
      weekly,
      buckets,
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }
  } catch (err) {
    return {
      provider: 'antigravity',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: err instanceof Error ? err.message : 'Unknown error',
      status: 'error'
    }
  }
}
