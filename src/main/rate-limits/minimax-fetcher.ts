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
  // Why: cookie is required for overseas and falls back for CN. The API key
  // path is the only case where cookie may be omitted entirely.
  cookie?: string
  groupId?: string | null
  models?: MiniMaxModelList
  endpoint?: string
  // Why: 'overseas' is cookie-only (the .io endpoint rejects bearer auth).
  // 'cn' prefers the API key when configured, falling back to cookie so users
  // who only pasted a cookie still see usage on either host.
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
  // Why: callers may pass an explicit endpoint override (e.g. legacy code
  // path). The endpoint selector still wins for the URL when no override is
  // supplied, so the .io / www.minimaxi.com hosts stay in sync with the
  // user's choice of endpoint.
  const endpoint = options.endpoint ?? getMiniMaxEndpointUrl(endpointMode)

  // Why: API key (Bearer) is the more reliable auth path — the cookie jar
  // also needs the right origin and Referer to land on. Both overseas and
  // CN accept the Bearer header, so an API key works on either endpoint.
  // The cookie path is the fallback for accounts that haven't generated a
  // key yet.
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
