import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  logMiniMaxFetchFailure,
  redactMiniMaxSecret,
  type MiniMaxFetchResponse
} from './minimax-request-context'
import {
  makeMiniMaxError,
  parseMiniMaxModels,
  parseMiniMaxUsageItem,
  selectMiniMaxSnapshot,
  type MiniMaxModelList,
  type MiniMaxUsageSnapshot
} from './minimax-fetcher-data'

// Why: split out of minimax-fetcher.ts so the transport + routing file
// stays under the 300-line cap (AGENTS.md disallows max-lines disables).
// Pure data-shape → ProviderRateLimits translation; no I/O.

export type MiniMaxUsageResponse = {
  base_resp?: {
    status_code?: unknown
    status_msg?: unknown
  }
  model_remains?: {
    model_name?: unknown
    current_interval_remaining_percent?: unknown
    start_time?: unknown
    end_time?: unknown
    remains_time?: unknown
    current_weekly_remaining_percent?: unknown
    weekly_remains_time?: unknown
    weekly_boost_permille?: unknown
  }[]
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
    const credentialLabel = fetchResult.transport === 'api-key' ? 'API key' : 'session cookie'
    return makeMiniMaxError(
      `MiniMax ${credentialLabel} expired. Replace it in Settings.`,
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
    return makeMiniMaxError(`MiniMax usage fetch failed (${response.status})`, 'server')
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
  return makeMiniMaxError(redactMiniMaxSecret(message), 'usage-unavailable')
}

export async function parseMiniMaxUsageResponse(
  fetchResult: MiniMaxFetchResponse,
  models: MiniMaxModelList
): Promise<ProviderRateLimits> {
  const httpError = handleMiniMaxHttpError(fetchResult)
  if (httpError) {
    return httpError
  }
  let payload: MiniMaxUsageResponse
  try {
    payload = (await fetchResult.response.json()) as MiniMaxUsageResponse
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid MiniMax usage response'
    return makeMiniMaxError(redactMiniMaxSecret(message), 'parse')
  }
  const payloadError = handleMiniMaxPayloadError(fetchResult, payload)
  if (payloadError) {
    return payloadError
  }
  // Why: a non-array `model_remains` (object / string) throws inside `.map`
  // and surfaces as a 'network' error rather than 'parse'. Treat any
  // non-array as an empty list and let the snapshot selection flag the
  // missing usage.
  const rawItems = Array.isArray(payload.model_remains) ? payload.model_remains : []
  const snapshots = rawItems
    .map(parseMiniMaxUsageItem)
    .filter((snapshot): snapshot is MiniMaxUsageSnapshot => snapshot !== null)
  const selected = selectMiniMaxSnapshot(snapshots, parseMiniMaxModels(models))
  if (!selected) {
    return makeMiniMaxError(
      'MiniMax usage data for the configured model was not found',
      'usage-unavailable'
    )
  }
  return {
    provider: 'minimax',
    session: selected.session,
    weekly: selected.weekly,
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: { source: 'web' }
  }
}
