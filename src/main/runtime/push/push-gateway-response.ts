// Why: the authorized request path and the handshake that authorizes it must
// classify a gateway response identically — otherwise the same 503 means "retry"
// on one leg and "give up" on the other, and register/send disagree about why.
import type { z } from 'zod'
import { cancelUnreadResponseBody } from '../../lib/unread-response-body'

export const PUSH_REQUEST_DEADLINE_MS = 15_000

export type PushGatewayFailure = { ok: false; reason: 'unreachable' | 'rejected' }
export type PushGatewayResult<T> = ({ ok: true } & T) | PushGatewayFailure
export type PushGatewayResponse = { ok: true; response: Response } | PushGatewayFailure

/** Unauthenticated POST; the handshake legs run before any session exists. */
export async function postPushGatewayJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  body: unknown
): Promise<PushGatewayResponse> {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // A 307 would replay the proof, and later the phone's token, to whatever
      // origin the redirect named.
      redirect: 'error',
      signal: AbortSignal.timeout(PUSH_REQUEST_DEADLINE_MS),
      body: JSON.stringify(body)
    })
    return { ok: true, response }
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
}

export async function readPushGatewayJson<TSchema extends z.ZodType>(
  result: PushGatewayResponse,
  schema: TSchema
): Promise<{ ok: true; value: z.infer<TSchema> } | PushGatewayFailure> {
  if (!result.ok) {
    return result
  }
  const { response } = result
  if (!response.ok) {
    await cancelUnreadResponseBody(response)
    // 5xx and 429 are worth another attempt later; anything else is the gateway
    // refusing this request as written.
    return {
      ok: false,
      reason: response.status >= 500 || response.status === 429 ? 'unreachable' : 'rejected'
    }
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    await cancelUnreadResponseBody(response)
    return { ok: false, reason: 'unreachable' }
  }
  const parsed = schema.safeParse(payload)
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: 'rejected' }
}
