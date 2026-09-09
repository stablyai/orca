import { z } from 'zod'
import { parseRelayRetryAfterMs } from '../../../src/shared/relay-retry-after-header'
import { MOBILE_RELAY_RETRY_AFTER_MAX_MS } from './mobile-relay-retry-delays'
import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'

const MAX_RESPONSE_BYTES = 16 * 1024

// Carries the director's own pacing so the reconnect cooldown can honor a
// bounded-overload 503 instead of re-dialing on the local backoff.
export class RelayDirectorHttpError extends Error {
  readonly name = 'RelayDirectorHttpError'

  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null
  ) {
    super(`relay director resolve failed (${status})`)
  }
}

// 0 when the director asked for nothing, so it only ever floors a local backoff.
export function relayDirectorRetryAfterMs(error: Error | null): number {
  return error instanceof RelayDirectorHttpError ? (error.retryAfterMs ?? 0) : 0
}

const ResolveResponseSchema = z
  .object({
    v: z.literal(1),
    cellUrl: z.string().refine(isCanonicalHttpsOrigin),
    assignmentEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    leaseExpiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()

export async function resolveMobileRelayEndpoint(args: {
  relay: MobileRelayEndpoint
  resumeToken: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<MobileRelayEndpoint> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 5000)
  try {
    const url = new URL('/v1/resolve', args.relay.directorUrl)
    const response = await (args.fetchImpl ?? fetch)(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        v: 1,
        relayHostId: args.relay.relayHostId,
        resumeToken: args.resumeToken
      }),
      signal: controller.signal
    })
    if (!response.ok) {
      throw new RelayDirectorHttpError(
        response.status,
        parseRelayRetryAfterMs(response.headers.get('retry-after'), MOBILE_RELAY_RETRY_AFTER_MAX_MS)
      )
    }
    const declaredLength = Number(response.headers.get('content-length') ?? 0)
    if (declaredLength > MAX_RESPONSE_BYTES) {
      throw new Error('relay director resolve response too large')
    }
    const raw = await response.text()
    if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES) {
      throw new Error('relay director resolve response too large')
    }
    const resolved = ResolveResponseSchema.parse(JSON.parse(raw) as unknown)
    return {
      ...args.relay,
      cellUrl: resolved.cellUrl,
      assignmentEpoch: resolved.assignmentEpoch
    }
  } finally {
    clearTimeout(timer)
  }
}

function isCanonicalHttpsOrigin(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && parsed.origin === value
  } catch {
    return false
  }
}
