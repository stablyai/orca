// Dev-signed tokens: the dev Workers accept an operator key set under their own issuers, so the eval
// runs before Orca Cloud auth mints sandbox/billing tokens. Dev sandbox accounts land in `dev:*`.
import { SignJWT, importJWK, type CryptoKey } from 'jose'
import { secrets } from './env'

export type Identity = { sub: string; org?: string; orgRole?: 'owner' | 'admin' | 'member'; email?: string }

let key: Promise<CryptoKey | Uint8Array> | null = null
function signingKey() {
  const jwk = secrets.devJwk()
  if (!jwk) {
    throw new Error('missing dev-jwk.json in the secrets dir')
  }
  key ??= importJWK(jwk.private, 'ES256')
  return key
}
function kid(): string {
  const jwk = secrets.devJwk() as { kid?: string; private: { kid?: string } } | null
  return jwk?.kid ?? jwk?.private.kid ?? 'dev1'
}

async function sign(claims: Record<string, unknown>, issuer: string, audience: string): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: kid() })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(await signingKey())
}

export function sandboxToken(who: Identity): Promise<string> {
  return sign({ ...who, purpose: 'sandbox' }, 'orca-sandbox-dev-test', 'orca-sandbox')
}

export function billingToken(who: Identity): Promise<string> {
  return sign({ ...who, purpose: 'billing' }, 'orca-billing-dev-test', 'orca-billing')
}
