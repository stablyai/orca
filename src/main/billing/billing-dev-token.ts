// Dev builds only: until Orca Cloud auth deploys /v1/desktop/auth/billing-token, sign billing
// tokens with the shared dev operator key (kid dev1) that the dev billing Worker trusts under
// its own issuer. Packaged builds never read the key file (see getBillingDevKeyFile).
import { createPrivateKey, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { OrcaOrgRole } from '../../shared/orca-profiles'

export const BILLING_DEV_ISSUER = 'orca-billing-dev-test'
const TOKEN_TTL_SECONDS = 300

const DevKeyFile = z.object({
  private: z.looseObject({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: z.string(),
    y: z.string(),
    d: z.string(),
    kid: z.string().optional()
  })
})

export function getBillingDevKeyFile(env: NodeJS.ProcessEnv, packaged: boolean): string | null {
  if (packaged) {
    return null
  }
  return env.ORCA_BILLING_DEV_KEY_FILE?.trim() || null
}

export type BillingDevClaims = {
  userId: string
  email?: string
  orgId?: string
  orgRole?: OrcaOrgRole
}

export function normalizeDevOrgRole(raw: string | undefined): OrcaOrgRole {
  const value = raw?.trim().toLowerCase()
  return value === 'owner' || value === 'admin' ? value : 'member'
}

export async function mintDevBillingToken(
  keyFile: string,
  claims: BillingDevClaims,
  nowMs: number = Date.now()
): Promise<string> {
  const parsed = DevKeyFile.parse(JSON.parse(await readFile(keyFile, 'utf8')))
  const key = createPrivateKey({ key: parsed.private, format: 'jwk' })
  // Backdate like auth does so a skewed Worker clock never rejects a fresh token.
  const now = Math.floor(nowMs / 1000) - 30
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  const header = encode({ alg: 'ES256', kid: parsed.private.kid ?? 'dev1' })
  const payload = encode({
    sub: claims.userId,
    ...(claims.orgId ? { org: claims.orgId, orgRole: claims.orgRole ?? 'member' } : {}),
    ...(claims.email ? { email: claims.email } : {}),
    purpose: 'billing',
    iss: BILLING_DEV_ISSUER,
    aud: 'orca-billing',
    iat: now,
    exp: now + TOKEN_TTL_SECONDS
  })
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), {
    key,
    dsaEncoding: 'ieee-p1363'
  })
  return `${header}.${payload}.${signature.toString('base64url')}`
}
