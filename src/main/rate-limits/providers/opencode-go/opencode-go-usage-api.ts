import { ensureElectronProxyFromEnvironment } from '../../../network/proxy-settings'
import { getMainHttpClient } from '../../../network/http-client'
import { abortSignalWithTimeout } from '../../../lib/abort-signal-with-timeout'
import { delayUnlessAborted } from '../../../../shared/concurrency/abort-aware-delay'
import { throwIfSignalAborted } from '../../../../shared/concurrency/abort-signal-reason'
import {
  parseOpenCodeGoUsageApiPayload,
  type OpenCodeGoUsageWindows
} from './opencode-go-status-parsing'
import { classifyThrownUsageRequestError } from '../usage-request-failure-kind'
import type { UsageRateLimitFailureKind } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'

export const OPENCODE_GO_USAGE_API_URL = 'https://opencode.ai/zen/go/v1/usage'
const API_TIMEOUT_MS = 15_000
const MAX_ERROR_BODY_CHARS = 4_000
const FETCH_ATTEMPTS = 3
const FETCH_RETRY_DELAY_MS = 400
// Only brief hiccups; persistent offline/DNS/cert/proxy failures would just delay the shared usage cycle.
const TRANSIENT_NET_ERROR =
  /^net::ERR_(CONNECTION_(RESET|CLOSED|ABORTED|TIMED_OUT)|NETWORK_CHANGED|ADDRESS_UNREACHABLE|EMPTY_RESPONSE|SSL_PROTOCOL_ERROR|HTTP2_PROTOCOL_ERROR|QUIC_PROTOCOL_ERROR)$/
const TRANSIENT_NODE_CODES = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EAI_AGAIN'
])
// A persistently blocked network would retry every poll and delay the shared usage cycle, so only an isolated blip gets retries.
let previousRequestFailedInTransport = false

/** Unauthorized/no-subscription are definitive key verdicts; failed means no usable answer. */
export type OpenCodeGoUsageApiOutcome =
  | { kind: 'ok'; windows: OpenCodeGoUsageWindows }
  | { kind: 'unauthorized' }
  | { kind: 'no-subscription' }
  | { kind: 'failed'; message: string; failureKind?: UsageRateLimitFailureKind }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readErrorType(body: string): string | null {
  if (!body || body.length > MAX_ERROR_BODY_CHARS) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(body)
    if (!isRecord(parsed) || !isRecord(parsed.error)) {
      return null
    }
    const type = parsed.error.type
    return typeof type === 'string' ? type : null
  } catch {
    return null
  }
}

function classifyFailure(status: number, body: string): OpenCodeGoUsageApiOutcome {
  const errorType = readErrorType(body)
  // Error names stay stable across consoles; a bare 403 can be an edge block, not an entitlement verdict.
  if (errorType === 'EntitlementError') {
    return { kind: 'no-subscription' }
  }
  if (errorType === 'AuthError' || status === 401) {
    return { kind: 'unauthorized' }
  }
  return { kind: 'failed', message: `OpenCode Go usage request failed (${status})` }
}

// Electron net.fetch rejects with the net:: string as the message; Node fetch rejects with TypeError and the code on cause.
function isTransientTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const { cause } = error
  const code = cause instanceof Error && 'code' in cause ? cause.code : undefined
  return (
    TRANSIENT_NET_ERROR.test(error.message) ||
    (typeof code === 'string' && TRANSIENT_NODE_CODES.has(code))
  )
}

async function fetchUsageResponse(
  apiKey: string,
  signal: AbortSignal,
  maxAttempts: number
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await getMainHttpClient().fetch(OPENCODE_GO_USAGE_API_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json'
        },
        signal
      })
    } catch (error) {
      if (signal.aborted || attempt >= maxAttempts || !isTransientTransportFailure(error)) {
        throw error
      }
      await delayUnlessAborted(FETCH_RETRY_DELAY_MS, signal)
      throwIfSignalAborted(signal)
    }
  }
}

/** Fetch via the default Electron session for app-wide proxy handling; the key stays in Authorization, never logs/results/telemetry. */
export async function fetchOpenCodeGoUsageWithApiKey(
  apiKey: string,
  signal?: AbortSignal
): Promise<OpenCodeGoUsageApiOutcome> {
  await ensureElectronProxyFromEnvironment({
    probeUrl: OPENCODE_GO_USAGE_API_URL
  }).catch(() => {})

  let response: Response
  try {
    // Retries share one timeout so a stalled endpoint still fails within API_TIMEOUT_MS.
    response = await fetchUsageResponse(
      apiKey,
      abortSignalWithTimeout(signal, API_TIMEOUT_MS),
      previousRequestFailedInTransport ? 1 : FETCH_ATTEMPTS
    )
    previousRequestFailedInTransport = false
  } catch (error) {
    previousRequestFailedInTransport = true
    // Exception messages may embed the authenticated request; return a fixed prefix.
    return {
      kind: 'failed',
      message: `OpenCode Go usage request failed (${error instanceof Error ? error.name : 'network error'})`,
      failureKind: classifyThrownUsageRequestError(error)
    }
  }

  const body = await response.text().catch(() => '')
  if (!response.ok) {
    return classifyFailure(response.status, body)
  }
  const windows = parseOpenCodeGoUsageApiPayload(body)
  if (!windows) {
    // Redirected sign-in pages can arrive as successful HTML responses.
    if (response.headers.get('content-type')?.includes('text/html')) {
      return { kind: 'unauthorized' }
    }
    return { kind: 'failed', message: 'Could not parse OpenCode Go usage response' }
  }
  return { kind: 'ok', windows }
}
