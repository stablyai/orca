import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose'
import { describe, expect, it } from 'vitest'
import { createHarness } from './harness'

const PROXY_URL = 'https://sandbox.test/v1/egress/proxy'
const ISSUER = 'https://oidc.vercel.com/team_orca'

async function setup() {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'v1', alg: 'RS256' }] }
  const upstream: { url: string; authorization: string | null }[] = []
  const h = await createHarness(
    { EGRESS_PROXY_URL: PROXY_URL },
    {
      egressKeysForIssuer: () => createLocalJWKSet(jwks),
      credentials: { authorizationFor: async (row, host) => (host === 'api.github.com' ? `Bearer ghs_for_${row.workspace_id}` : null) },
      egressFetch: async (input, init) => {
        upstream.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') })
        return new Response('{"login":"orca"}', { status: 200, headers: { 'content-type': 'application/json' } })
      }
    }
  )
  const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' } })
  const sandboxId: string = created.body.sandbox.id
  async function oidc(claims: Record<string, string>, audience = PROXY_URL) {
    return new SignJWT({ team_id: 'team_orca', project_id: 'prj_orca', sandbox_id: 'sbx-v', sandbox_name: `orca-test-${sandboxId}`, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'v1' })
      .setIssuer(ISSUER)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
  }
  async function proxied(init: { token: string; authorization?: string; host?: string }) {
    const response = await h.send(
      new Request(`${PROXY_URL}/user`, {
        headers: {
          'vercel-forwarded-host': init.host ?? 'api.github.com',
          'vercel-forwarded-scheme': 'https',
          'vercel-forwarded-port': '443',
          'vercel-forwarded-path': '/user',
          'vercel-sandbox-oidc-token': init.token,
          ...(init.authorization ? { authorization: init.authorization } : {})
        }
      })
    )
    return { status: response.status, body: await response.text() }
  }
  return { h, sandboxId, oidc, proxied, upstream }
}

describe('egress proxy (Vercel forwardURL target)', () => {
  it('swaps the placeholder for the workspace credential on a verified sandbox request', async () => {
    const { sandboxId, oidc, proxied, upstream } = await setup()
    const res = await proxied({ token: await oidc({}), authorization: `Bearer orca-ph-${sandboxId}` })
    expect(res).toEqual({ status: 200, body: '{"login":"orca"}' })
    expect(upstream).toEqual([{ url: 'https://api.github.com/user', authorization: 'Bearer ghs_for_ws-1' }])
  })

  it('refuses requests without the placeholder, from other teams, or for unproxied hosts', async () => {
    const { sandboxId, oidc, proxied, upstream } = await setup()
    const placeholder = `Bearer orca-ph-${sandboxId}`
    expect(await proxied({ token: await oidc({}), authorization: 'Bearer attacker' })).toEqual({ status: 403, body: 'placeholder_missing' })
    expect(await proxied({ token: await oidc({ team_id: 'team_other' }), authorization: placeholder })).toEqual({ status: 403, body: 'foreign_sandbox' })
    expect(await proxied({ token: await oidc({}, 'https://elsewhere.test'), authorization: placeholder })).toEqual({ status: 403, body: 'bad_oidc_token' })
    expect(await proxied({ token: await oidc({}), authorization: placeholder, host: 'example.com' })).toEqual({ status: 403, body: 'host_not_proxied' })
    expect(upstream).toEqual([])
  })

  it('forwards the placeholder route for api.github.com in the sandbox network policy', async () => {
    const { h, sandboxId } = await setup()
    const [box] = [...h.vercel.boxes.values()]
    expect(box!.policy.allow['api.github.com']).toEqual([
      {
        match: { headers: [{ key: { exact: 'authorization' }, value: { exact: `Bearer orca-ph-${sandboxId}` } }] },
        forwardURL: PROXY_URL
      },
      { response: { statusCode: 403, body: 'orca-egress-denied', contentType: 'text/plain' } }
    ])
  })
})
