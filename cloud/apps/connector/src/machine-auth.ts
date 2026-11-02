import type { MiddlewareHandler } from 'hono'
import {
  connectorHostId,
  readBearer,
  type ConnectorTokenVerifier
} from './connector-token-verifier.js'
import type { RateLimiter } from './rate-limiter.js'

// One machine of one account, as its connector token names it; expiresAt bounds what it may hold.
export type MachineHost = { hostId: string; accountId: string; expiresAt: number }
export type MachineEnv = { Variables: { host: MachineHost } }

export function machineAuth(deps: {
  verifyToken: ConnectorTokenVerifier
  hostRequests: RateLimiter
}): MiddlewareHandler<MachineEnv> {
  return async (context, next) => {
    const bearer = readBearer(context.req.header('authorization'))
    const claims = bearer ? await deps.verifyToken(bearer) : null
    if (!claims) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    const hostId = connectorHostId(claims)
    if (!deps.hostRequests.allow(hostId)) {
      return context.json({ error: 'rate_limited' }, 429)
    }
    context.set('host', { hostId, accountId: claims.sub, expiresAt: claims.exp * 1000 })
    await next()
  }
}
