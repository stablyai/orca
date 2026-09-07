import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import type { MiniMaxEndpoint } from '../../shared/global-settings-types'
import {
  extractMiniMaxCookieValue,
  fetchMiniMaxWithApiKey,
  fetchMiniMaxWithManualCookieHeader,
  fetchMiniMaxWithSessionCookieJar,
  getMiniMaxEndpointUrl,
  getUniqueMiniMaxCookieNames,
  makeMiniMaxRequestHeaders,
  MINIMAX_API_KEY_TIMEOUT_MS,
  normalizeMiniMaxCookieHeader,
  redactMiniMaxSecret,
  type MiniMaxFetchResponse
} from './minimax-request-context'
import { parseMiniMaxUsageResponse } from './minimax-fetcher-parse'
import {
  makeMiniMaxError,
  makeMiniMaxUnavailable,
  type MiniMaxModelList
} from './minimax-fetcher-data'

export {
  extractMiniMaxCookieValue,
  normalizeMiniMaxCookieHeader,
  redactMiniMaxSecret
} from './minimax-request-context'

const API_TIMEOUT_MS = 15_000

export type FetchMiniMaxRateLimitsOptions = {
  cookie?: string
  groupId?: string | null
  models?: MiniMaxModelList
  endpoint?: string
  endpointMode?: MiniMaxEndpoint
  apiKey?: string | null
}

async function fetchMiniMaxResponseWithCookie(args: {
  cookie: string
  endpoint: string
  groupId: string | null
  endpointMode: MiniMaxEndpoint
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
        requestHeaderNames: Object.keys(makeMiniMaxRequestHeaders(args.groupId, args.endpointMode))
      }
    )
    return await fetchMiniMaxWithManualCookieHeader(args)
  }
}

export async function fetchMiniMaxRateLimits(
  options: FetchMiniMaxRateLimitsOptions
): Promise<ProviderRateLimits> {
  const rawCookie = options.cookie?.trim() ?? ''
  const rawApiKey = options.apiKey?.trim() ?? ''
  const endpointMode: MiniMaxEndpoint = options.endpointMode ?? 'overseas'
  const endpoint = options.endpoint ?? getMiniMaxEndpointUrl(endpointMode)

  const useApiKey = rawApiKey.length > 0

  if (useApiKey) {
    return await fetchMiniMaxWithApiKeyFlow({
      apiKey: rawApiKey,
      endpoint,
      models: options.models
    })
  }

  if (!rawCookie) {
    return makeMiniMaxUnavailable('MiniMax session cookie not configured')
  }
  const cookie = normalizeMiniMaxCookieHeader(rawCookie)
  if (!extractMiniMaxCookieValue(cookie, '_token')) {
    return makeMiniMaxError(
      'MiniMax auth cookie not found — paste a Cookie header with _token',
      'missing-credentials'
    )
  }
  const groupId =
    options.groupId?.trim() || extractMiniMaxCookieValue(cookie, 'minimax_group_id_v2')
  try {
    const fetchResult = await fetchMiniMaxResponseWithCookie({
      cookie,
      endpoint,
      groupId,
      endpointMode,
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    })
    return await parseMiniMaxUsageResponse(fetchResult, options.models)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown MiniMax usage error'
    return makeMiniMaxError(redactMiniMaxSecret(message), 'network')
  }
}

async function fetchMiniMaxWithApiKeyFlow(args: {
  apiKey: string
  endpoint: string
  models: MiniMaxModelList
}): Promise<ProviderRateLimits> {
  try {
    const fetchResult = await fetchMiniMaxWithApiKey({
      apiKey: args.apiKey,
      endpoint: args.endpoint,
      signal: AbortSignal.timeout(MINIMAX_API_KEY_TIMEOUT_MS)
    })
    return await parseMiniMaxUsageResponse(fetchResult, args.models)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown MiniMax API key error'
    return makeMiniMaxError(redactMiniMaxSecret(message), 'network')
  }
}
