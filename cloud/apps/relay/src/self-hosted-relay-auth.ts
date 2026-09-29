import { createHash, timingSafeEqual } from 'node:crypto'
import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { SignJWT } from 'jose'
import { z } from 'zod'
import type { RelayConfig } from './config.js'
import { readBearer, selfHostedRelaySigningKey } from './relay-token-verifier.js'

const TokenRequestSchema = z
  .object({
    relayHostId: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
    hostPublicKeyB64: z.string().regex(/^[A-Za-z0-9+/]{43}=$/)
  })
  .strict()

export function registerSelfHostedRelayAuth(app: Hono, config: RelayConfig): void {
  const accessKey = config.selfHostedKey
  if (!accessKey) return
  const keyDigest = createHash('sha256').update(accessKey).digest()
  const signingKey = selfHostedRelaySigningKey(config)
  app.use('/v1/admin/*', async (context) => context.json({ error: 'not_found' }, 404))
  app.use('/v1/host-token', async (context, next) => {
    context.header('Cache-Control', 'no-store')
    const bearer = readBearer(context.req.header('authorization'))
    if (
      !bearer ||
      bearer.length > 256 ||
      !timingSafeEqual(createHash('sha256').update(bearer).digest(), keyDigest)
    ) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    return await next()
  })
  app.post('/v1/host-token', bodyLimit({ maxSize: 4096 }), async (context) => {
    const parsed = TokenRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) return context.json({ error: 'invalid_request' }, 400)
    const publicKey = Buffer.from(parsed.data.hostPublicKeyB64, 'base64')
    const relayHostId = createHash('sha256').update(publicKey).digest('base64url').slice(0, 16)
    if (
      publicKey.length !== 32 ||
      publicKey.toString('base64') !== parsed.data.hostPublicKeyB64 ||
      relayHostId !== parsed.data.relayHostId
    ) {
      return context.json({ error: 'invalid_request' }, 400)
    }
    const expiresAt = Math.floor(Date.now() / 1000) + 15 * 60
    const relayToken = await new SignJWT({
      prof: config.publicUrl,
      relayHostId,
      purpose: 'host-control'
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('self-hosted')
      .setIssuer(config.authIssuer)
      .setAudience(config.authAudience)
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .sign(signingKey)
    return context.json({ relayToken, expiresAt: expiresAt * 1000 })
  })
}
