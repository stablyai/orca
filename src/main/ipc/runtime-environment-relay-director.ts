import { z } from 'zod'
import type { MobileRelayEndpoint } from '../../shared/mobile-relay-credential-contract'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import { getMainHttpClient } from '../network/http-client'

const RELAY_RESOLVE_DEADLINE_MS = 5_000
const MAX_RELAY_RESOLVE_RESPONSE_CHARACTERS = 16 * 1024

const RelayResolveResponseSchema = z.object({
  v: z.literal(1),
  cellUrl: z.string().refine((value) => {
    try {
      const parsed = new URL(value)
      return parsed.protocol === 'https:' && parsed.origin === value
    } catch {
      return false
    }
  }),
  assignmentEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
})

export class RuntimeRelayResolveError extends Error {
  constructor(readonly status: number) {
    super(`relay_resolve_failed_${status}`)
  }
}

/** Asks the director which cell now owns a host after its old cell refused the resume credential. */
export async function resolveRuntimeRelayEndpoint(
  relay: MobileRelayEndpoint,
  resumeToken: string
): Promise<MobileRelayEndpoint> {
  const response = await getMainHttpClient().fetch(
    new URL('/v1/resolve', relay.directorUrl).toString(),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, relayHostId: relay.relayHostId, resumeToken }),
      signal: AbortSignal.timeout(RELAY_RESOLVE_DEADLINE_MS)
    }
  )
  if (!response.ok) {
    await cancelUnreadResponseBody(response)
    throw new RuntimeRelayResolveError(response.status)
  }
  const raw = await response.text()
  if (raw.length > MAX_RELAY_RESOLVE_RESPONSE_CHARACTERS) {
    throw new Error('relay_resolve_response_too_large')
  }
  const resolved = RelayResolveResponseSchema.parse(JSON.parse(raw))
  // Why: an older epoch is a stale director replica; dialing it would bounce straight back.
  if (resolved.assignmentEpoch < relay.assignmentEpoch) {
    throw new Error('relay_resolve_stale_assignment')
  }
  return { ...relay, cellUrl: resolved.cellUrl, assignmentEpoch: resolved.assignmentEpoch }
}
