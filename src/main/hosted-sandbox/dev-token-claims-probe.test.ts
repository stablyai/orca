import { afterEach, describe, expect, it } from 'vitest'
import { installDevTokenClaimsProbe, tokenOrgClaims } from './dev-token-claims-probe'

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
const jwt = (claims: unknown): string => `${encode({ alg: 'ES256' })}.${encode(claims)}.sig`

describe('dev token claims probe (GH-LIST-MISSING)', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, '__orcaCloudTokenClaims')
  })

  it('reads only org, role and user from the payload', () => {
    expect(tokenOrgClaims(jwt({ sub: 'u1', org: 'o1', org_role: 'owner', exp: 1 }))).toEqual({
      org: 'o1',
      orgRole: 'owner',
      sub: 'u1'
    })
    expect(tokenOrgClaims(jwt({ sub: 'u1' }))).toEqual({ org: null, orgRole: null, sub: 'u1' })
    expect(tokenOrgClaims('not-a-token')).toEqual({ org: null, orgRole: null, sub: null })
  })

  it('exists only in dev builds, and never hands back the token', async () => {
    expect(installDevTokenClaimsProbe(async () => jwt({ sub: 'u1', org: 'o1' }), true)).toBeNull()
    expect('__orcaCloudTokenClaims' in globalThis).toBe(false)
    const probe = installDevTokenClaimsProbe(async () => jwt({ sub: 'u1', org: 'o1' }), false)
    expect('__orcaCloudTokenClaims' in globalThis).toBe(true)
    const answer = await probe?.()
    expect(answer).toEqual({ org: 'o1', orgRole: null, sub: 'u1' })
    expect(JSON.stringify(answer)).not.toContain('sig')
  })
})
