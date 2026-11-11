import type { z } from 'zod'
import { ConnectorErrorResponse } from '../../shared/connector-cloud-contract'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

export type ConnectorFailure = {
  ok: false
  /** null when no readable HTTP answer arrived: network loss, timeout, or a body that is not the contract. */
  status: number | null
  /** The cloud's error code, when it sent one. */
  error: string | null
  retryAfterMs: number | null
}
/** An answer that is not the contract reads like no answer at all. */
export const UNREADABLE_ANSWER: ConnectorFailure = {
  ok: false,
  status: null,
  error: null,
  retryAfterMs: null
}

export type ConnectorResult<T> = { ok: true; value: T } | ConnectorFailure

export type ConnectorRequest = {
  fetchImpl: typeof globalThis.fetch
  url: string
  method?: 'POST' | 'PUT'
  body: unknown
  token?: string
  timeoutMs?: number
  signal?: AbortSignal
}

function failure(
  status: number | null,
  error: string | null = null,
  retryAfterMs: number | null = null
): ConnectorFailure {
  return { ok: false, status, error, retryAfterMs }
}

function readRetryAfterMs(response: Response): number | null {
  const seconds = Number(response.headers.get('retry-after'))
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null
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
        'content-type': 'application/json',
        ...(request.token ? { authorization: `Bearer ${request.token}` } : {})
      },
      // A redirect would replay the token to whatever origin it named.
      redirect: 'error',
      signal: request.signal ? AbortSignal.any([timeout, request.signal]) : timeout,
      body: JSON.stringify(request.body)
    })
  } catch {
    return failure(null)
  }
  if (!response.ok) {
    const error = ConnectorErrorResponse.safeParse(await readJson(response))
    return failure(
      response.status,
      error.success ? error.data.error : null,
      readRetryAfterMs(response)
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
