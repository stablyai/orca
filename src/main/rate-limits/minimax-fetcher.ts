import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import {
  extractMiniMaxCookieValue,
  fetchMiniMaxWithManualCookieHeader,
  fetchMiniMaxWithSessionCookieJar,
  getUniqueMiniMaxCookieNames,
  logMiniMaxFetchFailure,
  makeMiniMaxRequestHeaders,
  MINIMAX_USAGE_ENDPOINT,
  normalizeMiniMaxCookieHeader,
  redactMiniMaxSecret,
  type MiniMaxFetchResponse
} from './minimax-request-context'

export {
  extractMiniMaxCookieValue,
  normalizeMiniMaxCookieHeader,
  redactMiniMaxSecret
} from './minimax-request-context'

const API_TIMEOUT_MS = 15_000

type MiniMaxUsageItem = {
  model_name?: unknown
  current_interval_remaining_percent?: unknown
  start_time?: unknown
  end_time?: unknown
  remains_time?: unknown
}

type MiniMaxUsageResponse = {
  base_resp?: {
    status_code?: unknown
    status_msg?: unknown
  }
  model_remains?: MiniMaxUsageItem[]
}

type MiniMaxUsageSnapshot = {
  modelName: string
  window: RateLimitWindow
}

export type FetchMiniMaxRateLimitsOptions = {
  cookie: string
  groupId?: string | null
  models?: string | readonly string[] | null
  endpoint?: string
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function makeUnavailable(error: string): ProviderRateLimits {
  return {
    provider: 'minimax',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status: 'unavailable',
    usageMetadata: { failureKind: 'missing-credentials', source: 'web' }
  }
}

function makeError(
  error: string,
  failureKind: NonNullable<ProviderRateLimits['usageMetadata']>['failureKind']
): ProviderRateLimits {
  return {
    provider: 'minimax',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status: 'error',
    usageMetadata: { failureKind, source: 'web' }
  }
}

function parseModels(models: FetchMiniMaxRateLimitsOptions['models']): string[] {
  if (Array.isArray(models)) {
    const parsed = models.map((model) => model.trim()).filter(Boolean)
    return parsed.length > 0 ? parsed : ['general']
  }
  if (typeof models === 'string') {
    const parsed = models
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean)
    return parsed.length > 0 ? parsed : ['general']
  }
  return ['general']
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

// Why: MiniMax's API returns `end_time - start_time` that can drift below the
// 5-hour bucket (e.g. 4h or 295 min). The UI labels must reflect the contracted
// session — a fixed 5-hour window — so the status bar reads "5h" regardless of
// what the API reports. Mirrors how Codex always reports 300/10080 minutes.
const MINIMAX_SESSION_WINDOW_MINUTES = 300

function parseUsageItem(item: MiniMaxUsageItem): MiniMaxUsageSnapshot | null {
  const modelName = typeof item.model_name === 'string' ? item.model_name : null
  const remainingPercent = asNumber(item.current_interval_remaining_percent)
  const startTime = asNumber(item.start_time)
  const endTime = asNumber(item.end_time)
  if (!modelName || remainingPercent === null || startTime === null || endTime === null) {
    return null
  }
  return {
    modelName,
    window: {
      usedPercent: clampPercent(100 - remainingPercent),
      windowMinutes: MINIMAX_SESSION_WINDOW_MINUTES,
      resetsAt: endTime,
      resetDescription: null
    }
  }
}

function selectSnapshot(
  snapshots: MiniMaxUsageSnapshot[],
  preferredModels: string[]
): MiniMaxUsageSnapshot | null {
  for (const model of preferredModels) {
    const match = snapshots.find((snapshot) => snapshot.modelName === model)
    if (match) {
      return match
    }
  }
  return snapshots.length === 1 ? snapshots[0] : null
}

async function fetchMiniMaxResponse(args: {
  cookie: string
  endpoint: string
  groupId: string | null
  signal: AbortSignal
}): Promise<MiniMaxFetchResponse> {
  try {
    return await fetchMiniMaxWithSessionCookieJar(args)
  } catch (sessionFetchError) {
    const message =
      sessionFetchError instanceof Error ? sessionFetchError.message : String(sessionFetchError)
    console.warn(
      '[minimax] session cookie jar fetch failed; falling back to manual Cookie header',
      {
        error: redactMiniMaxSecret(message),
        cookieNames: getUniqueMiniMaxCookieNames(args.cookie),
        requestHeaderNames: Object.keys(makeMiniMaxRequestHeaders(args.groupId))
      }
    )
    return await fetchMiniMaxWithManualCookieHeader(args)
  }
}

function handleMiniMaxHttpError(fetchResult: MiniMaxFetchResponse): ProviderRateLimits | null {
  const { response } = fetchResult
  if (response.status === 401 || response.status === 403) {
    logMiniMaxFetchFailure({
      transport: fetchResult.transport,
      responseStatus: response.status,
      cookieNames: fetchResult.cookieNames,
      requestHeaderNames: fetchResult.requestHeaderNames
    })
    return makeError(
      'MiniMax session expired. Replace the MiniMax cookie in Settings.',
      'stale-token'
    )
  }
  if (!response.ok) {
    logMiniMaxFetchFailure({
      transport: fetchResult.transport,
      responseStatus: response.status,
      cookieNames: fetchResult.cookieNames,
      requestHeaderNames: fetchResult.requestHeaderNames
    })
    return makeError(`MiniMax usage fetch failed (${response.status})`, 'server')
  }
  return null
}

function handleMiniMaxPayloadError(
  fetchResult: MiniMaxFetchResponse,
  payload: MiniMaxUsageResponse
): ProviderRateLimits | null {
  const statusCode = payload.base_resp?.status_code
  if (statusCode === undefined || statusCode === 0) {
    return null
  }
  logMiniMaxFetchFailure({
    transport: fetchResult.transport,
    responseStatus: fetchResult.response.status,
    statusCode,
    statusMsg: payload.base_resp?.status_msg,
    cookieNames: fetchResult.cookieNames,
    requestHeaderNames: fetchResult.requestHeaderNames
  })
  const message =
    typeof payload.base_resp?.status_msg === 'string'
      ? payload.base_resp.status_msg
      : 'MiniMax returned an error'
  return makeError(redactMiniMaxSecret(message), 'usage-unavailable')
}

export async function fetchMiniMaxRateLimits(
  options: FetchMiniMaxRateLimitsOptions
): Promise<ProviderRateLimits> {
  const rawCookie = options.cookie.trim()
  if (!rawCookie) {
    return makeUnavailable('MiniMax session cookie not configured')
  }
  const cookie = normalizeMiniMaxCookieHeader(rawCookie)
  if (!extractMiniMaxCookieValue(cookie, '_token')) {
    return makeError(
      'MiniMax auth cookie not found — paste a Cookie header with _token',
      'missing-credentials'
    )
  }
  const groupId =
    options.groupId?.trim() || extractMiniMaxCookieValue(cookie, 'minimax_group_id_v2')
  try {
    const fetchResult = await fetchMiniMaxResponse({
      cookie,
      endpoint: options.endpoint ?? MINIMAX_USAGE_ENDPOINT,
      groupId,
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    })
    const httpError = handleMiniMaxHttpError(fetchResult)
    if (httpError) {
      return httpError
    }
    let payload: MiniMaxUsageResponse
    try {
      payload = (await fetchResult.response.json()) as MiniMaxUsageResponse
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid MiniMax usage response'
      return makeError(redactMiniMaxSecret(message), 'parse')
    }
    const payloadError = handleMiniMaxPayloadError(fetchResult, payload)
    if (payloadError) {
      return payloadError
    }
    const snapshots = (payload.model_remains ?? [])
      .map(parseUsageItem)
      .filter((snapshot): snapshot is MiniMaxUsageSnapshot => snapshot !== null)
    const selected = selectSnapshot(snapshots, parseModels(options.models))
    if (!selected) {
      return makeError(
        'MiniMax usage data for the configured model was not found',
        'usage-unavailable'
      )
    }
    return {
      provider: 'minimax',
      session: selected.window,
      weekly: null,
      updatedAt: Date.now(),
      error: null,
      status: 'ok',
      usageMetadata: { source: 'web' }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown MiniMax usage error'
    return makeError(redactMiniMaxSecret(message), 'network')
  }
}
