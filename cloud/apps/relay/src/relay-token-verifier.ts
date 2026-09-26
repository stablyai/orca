import { createHmac } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { z } from 'zod'
import type { RelayConfig } from './config.js'

const ClaimsSchema = z.object({
  sub: z.string().min(1),
  prof: z.string().min(1),
  org: z.string().min(1).optional(),
  relayHostId: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  purpose: z.literal('host-control'),
  exp: z.number().int().positive()
})

export type RelayTokenClaims = z.infer<typeof ClaimsSchema>

// Keep host authorization separate from assignment leases even on a single-server install.
export function selfHostedRelaySigningKey(config: RelayConfig): Uint8Array {
  return createHmac('sha256', config.assignmentSigningKey)
    .update('orca-self-hosted-relay-host-control-v1')
    .digest()
}

export function createRelayTokenVerifier(
  config: RelayConfig
): (token: string) => Promise<RelayTokenClaims | null> {
  const signingKey = config.selfHostedKey ? selfHostedRelaySigningKey(config) : undefined
  const key = signingKey ? async () => signingKey : createRemoteJWKSet(new URL(config.jwksUrl!))
  return async (token) => {
    try {
      const verified = await jwtVerify(token, key, {
        issuer: config.authIssuer,
        audience: config.authAudience,
        algorithms: [config.selfHostedKey ? 'HS256' : 'ES256']
      })
      return ClaimsSchema.parse(verified.payload)
    } catch {
      return null
    }
  }
}

export function readBearer(value: string | undefined): string | null {
  const match = /^Bearer ([^\s]+)$/.exec(value ?? '')
  return match?.[1] ?? null
}
