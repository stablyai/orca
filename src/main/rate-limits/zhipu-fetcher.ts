import { net } from 'electron'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import { isZhipuUsageHost, normalizeZhipuBaseUrl } from '../../shared/zhipu-usage'

const API_TIMEOUT_MS = 10_000
const ZHIPU_SESSION_WINDOW_MINUTES = 300
const ZHIPU_MONTHLY_WINDOW_MINUTES = 43_200

type ZhipuQuotaLimitItem = {
  type?: unknown
  percentage?: unknown
  currentValue?: unknown
  usage?: unknown
  usageDetails?: unknown
}

type ZhipuQuotaLimitResponse = {
  data?: {
    limits?: unknown
  }
  limits?: unknown
}

export type FetchZhipuRateLimitsOptions = {
  baseUrl?: string | null
  authToken?: string | null
  endpoint?: string
  signal?: AbortSignal
}

function result(
  status: ProviderRateLimits['status'],
  error: string | null,
  failureKind?: NonNullable<ProviderRateLimits['usageMetadata']>['failureKind']
): ProviderRateLimits {
  return {
    provider: 'zhipu',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: Date.now(),
    error,
    status,
    ...(failureKind ? { usageMetadata: { failureKind, source: 'web' } } : {})
  }
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function resolveUsageEndpoint(
  baseUrl: string,
  endpoint?: string
): { endpoint: string; host: string } {
  if (endpoint) {
    const url = new URL(endpoint)
    if (!isZhipuUsageHost(url.host)) {
      throw new Error(`Unsupported Zhipu usage host: ${url.host}`)
    }
    return { endpoint: url.toString(), host: url.host }
  }
  const url = new URL(baseUrl)
  if (!isZhipuUsageHost(url.host)) {
    throw new Error(`Unsupported Zhipu usage host: ${url.host}`)
  }
  return {
    endpoint: `${url.origin}/api/monitor/usage/quota/limit`,
    host: url.host
  }
}

function extractLimitItems(payload: ZhipuQuotaLimitResponse): ZhipuQuotaLimitItem[] {
  const limits = payload.data?.limits ?? payload.limits
  if (!Array.isArray(limits)) {
    return []
  }
  return limits.filter(
    (item): item is ZhipuQuotaLimitItem => typeof item === 'object' && item !== null
  )
}

function mapPercentWindow(
  item: ZhipuQuotaLimitItem,
  windowMinutes: number
): RateLimitWindow | null {
  const percentage = asNumber(item.percentage)
  if (percentage === null) {
    return null
  }
  return {
    usedPercent: clampPercent(percentage),
    windowMinutes,
    resetsAt: null,
    resetDescription: null
  }
}

function mapQuotaLimitPayload(
  payload: ZhipuQuotaLimitResponse,
  authProvenance: string
): ProviderRateLimits {
  let session: RateLimitWindow | null = null
  let monthly: RateLimitWindow | null = null
  for (const item of extractLimitItems(payload)) {
    if (item.type === 'TOKENS_LIMIT') {
      session = mapPercentWindow(item, ZHIPU_SESSION_WINDOW_MINUTES)
    } else if (item.type === 'TIME_LIMIT') {
      monthly = mapPercentWindow(item, ZHIPU_MONTHLY_WINDOW_MINUTES)
    }
  }
  if (!session && !monthly) {
    return result(
      'error',
      'Zhipu usage response did not include quota windows',
      'usage-unavailable'
    )
  }
  return {
    provider: 'zhipu',
    session,
    weekly: null,
    monthly,
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: {
      source: 'web',
      authProvenance
    }
  }
}

export async function fetchZhipuRateLimits(
  options: FetchZhipuRateLimitsOptions
): Promise<ProviderRateLimits> {
  const authToken = options.authToken?.trim() ?? ''
  if (!authToken) {
    return result('unavailable', 'Zhipu auth token not configured', 'missing-credentials')
  }
  try {
    const baseUrl = normalizeZhipuBaseUrl(options.baseUrl)
    const resolved = resolveUsageEndpoint(baseUrl, options.endpoint)
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(API_TIMEOUT_MS)])
      : AbortSignal.timeout(API_TIMEOUT_MS)
    const response = await net.fetch(resolved.endpoint, {
      method: 'GET',
      headers: {
        Authorization: authToken,
        Accept: 'application/json',
        'Accept-Language': 'en-US,en',
        'Content-Type': 'application/json'
      },
      signal
    })
    if (response.status === 401 || response.status === 403) {
      return result('error', 'Zhipu usage request unauthorized', 'stale-token')
    }
    if (!response.ok) {
      return result('error', `Zhipu usage fetch failed (${response.status})`, 'server')
    }
    let payload: ZhipuQuotaLimitResponse
    try {
      const data: unknown = await response.json()
      payload = typeof data === 'object' && data !== null ? (data as ZhipuQuotaLimitResponse) : {}
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid Zhipu usage response'
      return result('error', message, 'parse')
    }
    return mapQuotaLimitPayload(payload, `Zhipu / ${resolved.host}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Zhipu usage request failed'
    return result('error', message, 'network')
  }
}
