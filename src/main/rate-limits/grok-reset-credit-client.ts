import { net } from 'electron'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import type { RateLimitResetCredits } from './codex-reset-credit-client'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import type { GrokAuthSession } from './grok-auth'
import {
  decodeRemainingResetTokens,
  encodeGrpcWebRequest,
  mapRemainingResetTokens,
  parseGrpcWebResponse
} from './grok-reset-credit-proto'

export {
  decodeRemainingResetTokens,
  encodeGetRemainingResetsResponse,
  encodeGrpcWebMessage,
  encodeGrpcWebRequest,
  mapRemainingResetTokens,
  parseGrpcWebResponse
} from './grok-reset-credit-proto'
export type { GrokRemainingResetToken } from './grok-reset-credit-proto'

const GROK_WEB_ORIGIN = 'https://grok.com'
export const GROK_REMAINING_RESETS_URL = `${GROK_WEB_ORIGIN}/prod_mc_billing.ConsumerUiSvc/GetRemainingResets`

const GROK_CLI_AUTH_HEADER = 'xai-grok-cli'
const FETCH_TIMEOUT_MS = 10_000

export type GrokRpcRequest = (url: string, init: RequestInit) => Promise<Response>

function grokRpcHeaders(session: GrokAuthSession): Record<string, string> {
  // Why: the billing RPC accepts the CLI token with only gRPC-Web framing; browser identity headers add no authorization.
  return {
    Authorization: `Bearer ${session.accessToken}`,
    'X-XAI-Token-Auth': GROK_CLI_AUTH_HEADER,
    'Content-Type': 'application/grpc-web+proto',
    'x-grpc-web': '1'
  }
}

class GrokResetInventoryAuthenticationError extends Error {}

function defaultGrokRpcRequest(url: string, init: RequestInit): Promise<Response> {
  return net.fetch(url, init)
}

function headerValue(headers: Headers | undefined, name: string): string | null {
  return typeof headers?.get === 'function' ? headers.get(name) : null
}

async function postGrokRpc(
  url: string,
  session: GrokAuthSession,
  payload: Uint8Array<ArrayBufferLike>,
  options: {
    signal?: AbortSignal
    timeoutMs: number
    request?: GrokRpcRequest
  }
): Promise<{
  payload: Uint8Array<ArrayBufferLike>
  grpcStatus: string
  grpcMessage: string | null
}> {
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const request = options.request ?? defaultGrokRpcRequest
  const response = await request(url, {
    method: 'POST',
    headers: grokRpcHeaders(session),
    body: encodeGrpcWebRequest(payload),
    signal
  })
  if (!response.ok) {
    await cancelUnreadResponseBody(response)
    if (response.status === 401 || response.status === 403) {
      throw new GrokResetInventoryAuthenticationError(
        `Grok reset request unauthorized (HTTP ${response.status})`
      )
    }
    throw new Error(`Grok reset request failed (HTTP ${response.status})`)
  }
  const raw = new Uint8Array(await response.arrayBuffer())
  return parseGrpcWebResponse(
    raw,
    headerValue(response.headers, 'grpc-status'),
    headerValue(response.headers, 'grpc-message')
  )
}

export async function fetchGrokRateLimitResetCredits(
  session: GrokAuthSession,
  options: { signal?: AbortSignal; request?: GrokRpcRequest } = {}
): Promise<RateLimitResetCredits | null> {
  if (options.signal?.aborted) {
    return null
  }
  try {
    const rpc = await postGrokRpc(GROK_REMAINING_RESETS_URL, session, new Uint8Array(), {
      signal: options.signal,
      timeoutMs: FETCH_TIMEOUT_MS,
      request: options.request
    })
    if (rpc.grpcStatus === '16') {
      throw new GrokResetInventoryAuthenticationError(
        rpc.grpcMessage
          ? `Grok reset-token inventory unauthorized: ${rpc.grpcMessage}`
          : 'Grok reset-token inventory unauthorized'
      )
    }
    if (rpc.grpcStatus !== '0') {
      return null
    }
    return mapRemainingResetTokens(decodeRemainingResetTokens(rpc.payload))
  } catch (error) {
    if (error instanceof GrokResetInventoryAuthenticationError) {
      throw error
    }
    return null
  }
}

export async function supplementGrokRateLimitResetCredits(
  limits: ProviderRateLimits,
  session: GrokAuthSession,
  options: {
    signal?: AbortSignal
    request?: GrokRpcRequest
    previousRateLimitResetCredits?: RateLimitResetCredits
  } = {}
): Promise<ProviderRateLimits> {
  if (options.signal?.aborted || limits.provider !== 'grok' || limits.status !== 'ok') {
    return limits
  }
  const rateLimitResetCredits = await fetchGrokRateLimitResetCredits(session, options)
  if (rateLimitResetCredits) {
    return { ...limits, rateLimitResetCredits }
  }
  return options.previousRateLimitResetCredits
    ? { ...limits, rateLimitResetCredits: options.previousRateLimitResetCredits }
    : limits
}
