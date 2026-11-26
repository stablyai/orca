import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import { z } from 'zod'
import { ConnectorErrorResponse } from '../../shared/connectors/connector-cloud-contract'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

// A refusal may carry words for the owner, e.g. why `host_key_limit` refused this machine; control
// and bidi characters become spaces so they can't reshape where it is shown.
const ConnectorRefusal = lazyZodSchema(() =>
  ConnectorErrorResponse.extend({
    reason: z.string().max(64).optional().catch(undefined),
    message: z
      .string()
      .max(500)
      .transform((text) => text.replace(/[\p{Cc}\p{Cf}\u2028\u2029\s]+/gu, ' ').trim() || undefined)
      .optional()
      .catch(undefined)
  })
)

export type ConnectorFailure = {
  ok: false
  /** null when no readable HTTP answer arrived: network loss, timeout, or a body that is not the contract. */
  status: number | null
  /** The cloud's error code, when it sent one. */
  error: string | null
  retryAfterMs: number | null
  /** The cloud's words for the owner, when it sent some. */
  message?: string
  /** The cloud's tag for its refusal, e.g. `features` on a hello_required for a feature change. */
  reason?: string
  /** The connector-token route still refused this sign-in after the shared session refresh. */
  sessionRefused?: true
}
/** An answer that is not the contract reads like no answer at all. */
export const UNREADABLE_ANSWER: ConnectorFailure = {
  ok: false,
  status: null,
  error: null,
  retryAfterMs: null
}

// The auth service's refusals of this computer's sign-in: pinned to another machine, not a
// desktop's, or holding a host key the cloud doesn't know for this install (a fresh sign-in resets it).
const SIGN_IN_STOPS: ReadonlySet<string> = new Set([
  'machine_mismatch',
  'desktop_session_required',
  'host_key_mismatch',
  'recent_sign_in_required'
])

/** A refusal no retry can fix, e.g. `client_too_old`; any other failure is retried after a backoff. */
export function connectorStop(failure: ConnectorFailure): string | null {
  if (failure.status === 426) {
    return 'client_too_old'
  }
  // The cloud requires a host-key proof this host could not make (its key file is unreadable).
  if (failure.status === 403 && failure.error === 'host_proof_required') {
    return 'host_proof_required'
  }
  return failure.status === 403 && failure.error && SIGN_IN_STOPS.has(failure.error)
    ? failure.error
    : null
}

/** Whether only signing in to Orca again on this computer lifts the stop. */
export function connectorStopNeedsSignIn(stop: string | null): boolean {
  return stop !== null && SIGN_IN_STOPS.has(stop)
}

/** No account to call as: signed out, switched away, or Orca quitting. */
export const SIGNED_OUT: ConnectorFailure = {
  ok: false,
  status: 401,
  error: 'signed_out',
  retryAfterMs: null
}

export type ConnectorResult<T> = { ok: true; value: T } | ConnectorFailure

export type ConnectorRequest = {
  fetchImpl: typeof globalThis.fetch
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** Omitted for a GET or DELETE. */
  body?: unknown
  token?: string
  timeoutMs?: number
  signal?: AbortSignal
}

function failure(
  status: number | null,
  error: string | null = null,
  retryAfterMs: number | null = null,
  message?: string,
  reason?: string
): ConnectorFailure {
  return {
    ok: false,
    status,
    error,
    retryAfterMs,
    ...(message ? { message } : {}),
    ...(reason ? { reason } : {})
  }
}

/** The longest Retry-After honoured; past it a timer could overflow and fire at once, in a loop. */
export const CONNECTOR_MAX_RETRY_AFTER_MS = 10 * 60_000

function readRetryAfterMs(response: Response): number | null {
  const seconds = Number(response.headers.get('retry-after'))
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, CONNECTOR_MAX_RETRY_AFTER_MS)
    : null
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    await cancelUnreadResponseBody(response)
    return undefined
  }
}

export async function requestConnector<TSchema extends z.ZodType>(
  request: ConnectorRequest,
  schema: TSchema
): Promise<ConnectorResult<z.infer<TSchema>>> {
  const timeout = AbortSignal.timeout(request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
  let response: Response
  try {
    response = await request.fetchImpl(request.url, {
      method: request.method ?? 'POST',
      headers: {
        ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(request.token ? { authorization: `Bearer ${request.token}` } : {})
      },
      // A redirect would replay the token to whatever origin it named.
      redirect: 'error',
      signal: request.signal ? AbortSignal.any([timeout, request.signal]) : timeout,
      body: request.body === undefined ? undefined : JSON.stringify(request.body)
    })
  } catch {
    return failure(null)
  }
  if (!response.ok) {
    const error = ConnectorRefusal.safeParse(await readJson(response))
    return failure(
      response.status,
      error.success ? error.data.error : null,
      readRetryAfterMs(response),
      error.success ? error.data.message : undefined,
      error.success ? error.data.reason : undefined
    )
  }
  // Only the contract's success counts: 204 with no body for a no-content reader, 200 with its JSON.
  if (response.status !== 200 && response.status !== 204) {
    await cancelUnreadResponseBody(response)
    return failure(null)
  }
  const payload = response.status === 204 ? undefined : await readJson(response)
  if (response.status === 200 && payload === undefined) {
    return failure(null)
  }
  const parsed = schema.safeParse(payload)
  return parsed.success ? { ok: true, value: parsed.data } : failure(null)
}
