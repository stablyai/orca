import { z } from 'zod'
import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'

const MAX_RESPONSE_BYTES = 16 * 1024
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
      throw new Error(`relay director resolve failed (${response.status})`)
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
