// Classify handshake and authorized responses identically so retries and refusal reasons cannot diverge.
import type { z } from 'zod'
import { cancelUnreadResponseBody } from '../../lib/unread-response-body'
import { describePushGatewayTransportFailure } from './push-gateway-transport-diagnostics'

export const PUSH_REQUEST_DEADLINE_MS = 15_000

export type PushGatewayFailure = {
  ok: false
  reason: 'unreachable' | 'rejected'
  /** Set when sign-in was refused because this host's clock is this far ahead (negative: behind). */
  clockSkewMs?: number
}
export type PushGatewayResult<T> = ({ ok: true } & T) | PushGatewayFailure
export type PushGatewayResponse = { ok: true; response: Response } | PushGatewayFailure

/** Unauthenticated POST; the handshake legs run before any session exists. */
export async function postPushGatewayJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  body: unknown,
  onTransportFailure?: (description: string) => void
): Promise<PushGatewayResponse> {
  let signal: AbortSignal | undefined
  try {
    signal = AbortSignal.timeout(PUSH_REQUEST_DEADLINE_MS)
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // A 307 would replay the proof, and later the phone's token, to whatever
      // origin the redirect named.
      redirect: 'error',
      signal,
      body: JSON.stringify(body)
    })
    return { ok: true, response }
  } catch (error) {
    try {
      onTransportFailure?.(describePushGatewayTransportFailure(error, signal))
    } catch {
      // Logging must not change the failure exposed to registration or dispatch.
    }
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
