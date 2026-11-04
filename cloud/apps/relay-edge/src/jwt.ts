import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose'
import type { EdgeClaims, Env } from './env'

export const HOST_ID = /^[A-Za-z0-9_-]{16}$/

export async function verifyRelayJwt(env: Env, token: string): Promise<EdgeClaims | null> {
  try {
    const jwks = createLocalJWKSet(JSON.parse(env.RELAY_JWKS) as JSONWebKeySet)
    const { payload } = await jwtVerify(token, jwks, {
      audience: env.RELAY_JWT_AUDIENCE,
      algorithms: ['ES256']
    })
    if (
      payload.purpose !== 'host-control' ||
      typeof payload.sub !== 'string' ||
      typeof payload.prof !== 'string' ||
      typeof payload.relayHostId !== 'string' ||
      !HOST_ID.test(payload.relayHostId)
    ) {
      return null
    }
    return {
      userId: payload.sub,
      profileId: payload.prof,
      organizationId: typeof payload.org === 'string' ? payload.org : '',
      relayHostId: payload.relayHostId,
      exp: typeof payload.exp === 'number' ? payload.exp * 1000 : 0
    }
  } catch {
    return null
  }
}

