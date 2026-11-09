import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose'
import { describe, expect, it } from 'vitest'
import { generateGrantRecipientKey } from '../../../../src/main/cloud-workspaces/sealed-grant-node'
import { memberPlaceholder } from '../src/github-user-tokens'
import { MEMBERS_COMMAND } from '../src/lifecycle'
import { gitBasicAuthorization } from '../src/network-policy'
import { createHarness } from './harness'

const PROXY_URL = 'https://sandbox.test/v1/egress/proxy'
const ISSUER = 'https://oidc.vercel.com/team_orca'
const KEK = Buffer.alloc(32, 7).toString('base64')
const OP = 'o'.repeat(40)
const REPO = 'https://github.com/acme/app'

async function setup(memberGit: string | undefined = undefined) {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'v1', alg: 'RS256' }] }
  const upstream: { url: string; authorization: string | null }[] = []
  const h = await createHarness(
    { EGRESS_PROXY_URL: PROXY_URL, SECRETS_KEK: KEK, OPERATOR_TOKEN: OP, ...(memberGit ? { MEMBER_GIT_IDENTITY: memberGit } : {}) },
    {
      egressKeysForIssuer: () => createLocalJWKSet(jwks),
      credentials: { authorizationFor: async () => 'Bearer ghs_app' },
      github: {
        tokenForRepo: async (url: string) => ({ token: `ghs_member_stand_in_for_${url.split('/').at(-1)}`, expiresAt: h.now() + 3_600_000 }),
        installationForRepo: async () => null
      } as never,
      egressFetch: async (input, init) => {
        upstream.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') })
        return new Response('ok', { status: 200 })
      }
    }
  )
  const as = (sub: string, role = 'member') => h.token(sub, 'acme', 'sandbox', { org_role: role })
  const created = await h.call('POST', '/v1/sandboxes', {
    bearer: await as('alice'),
    body: { workspaceId: 'ws-1', machineSize: 'standard', repo: { url: REPO }, visibility: 'team' }
  })
  const id: string = created.body.sandbox.id
  const sent = async (userId: string) =>
    h.call('POST', `/v1/team/workspaces/${id}/sent`, { bearer: await as(userId) })
  // Connect GitHub, then (their own client) report a send so their identity window is open.
  const seed = async (userId: string, login: string, githubUserId: number, send = true) => {
    const stored = await h.call('POST', '/v1/internal/dev/member-github', {
      bearer: OP,
      body: { accountId: 'org:acme', userId, repoUrl: REPO, login, githubUserId, name: `${login} name` }
    })
    if (send) {
      await sent(userId)
    }
    return stored
  }
  async function oidc() {
    return new SignJWT({ team_id: 'team_orca', project_id: 'prj_orca', sandbox_id: 'sbx-v', sandbox_name: `orca-test-${id}` })
      .setProtectedHeader({ alg: 'RS256', kid: 'v1' })
      .setIssuer(ISSUER)
      .setAudience(PROXY_URL)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
  }
  async function proxied(host: string, path: string, authorization: string) {
    const response = await h.send(
      new Request(`${PROXY_URL}${path}`, {
        method: 'POST',
        body: 'pack',
        headers: {
          'vercel-forwarded-host': host,
          'vercel-forwarded-scheme': 'https',
          'vercel-forwarded-port': '443',
          'vercel-forwarded-path': path,
          'vercel-sandbox-oidc-token': await oidc(),
          authorization
        }
      })
    )
    return { status: response.status, body: await response.text() }
  }
  return { h, id, as, seed, sent, proxied, upstream }
}

describe('git as the sender', () => {
  it('routes each connected member placeholder to their own token, only for the workspace repo', async () => {
    const t = await setup()
    expect((await t.seed('alice', 'alice-gh', 11)).body.stored).toBe(true)
    const alicePh = await memberPlaceholder(t.id, 'alice')
    const push = await t.proxied('github.com', '/acme/app.git/git-receive-pack', gitBasicAuthorization(alicePh))
    expect(push.status).toBe(200)
    expect(t.upstream.at(-1)).toEqual({
      url: 'https://github.com/acme/app.git/git-receive-pack',
      authorization: gitBasicAuthorization('ghs_member_stand_in_for_app')
    })
    // The member token is pinned to the workspace repository.
    expect(await t.proxied('github.com', '/acme/other.git/git-receive-pack', gitBasicAuthorization(alicePh))).toEqual({ status: 403, body: 'path_not_allowed' })
    expect(await t.proxied('github.com', '/acme/app.git/../other.git/info/refs', gitBasicAuthorization(alicePh))).toEqual({ status: 403, body: 'path_not_allowed' })
    expect((await t.proxied('api.github.com', '/repos/acme/app/pulls', `Bearer ${alicePh}`)).status).toBe(200)
    expect(await t.proxied('api.github.com', '/user/repos', `Bearer ${alicePh}`)).toEqual({ status: 403, body: 'path_not_allowed' })
    // A teammate without a grant has no route at all, even if connected.
    await t.seed('bob', 'bob-gh', 22)
    const bobPh = await memberPlaceholder(t.id, 'bob')
    expect(await t.proxied('github.com', '/acme/app.git/git-receive-pack', gitBasicAuthorization(bobPh))).toEqual({ status: 403, body: 'placeholder_missing' })
  })

  it('adds a member to the policy and the VM git configs when they get a grant, and drops them on revoke', async () => {
    const t = await setup()
    await t.seed('alice', 'alice-gh', 11)
    await t.seed('bob', 'bob-gh', 22)
    const bob = await t.as('bob')
    const issued = await t.h.call('POST', `/v1/team/workspaces/${t.id}/grants`, {
      bearer: bob,
      body: { recipientPublicKeyB64: generateGrantRecipientKey().publicKeyB64, deviceLabel: 'b', deviceKind: 'desktop' }
    })
    expect(issued.status).toBe(200)
    const box = [...t.h.vercel.boxes.values()][0]!
    const bobPh = gitBasicAuthorization(await memberPlaceholder(t.id, 'bob'))
    const githubRules = JSON.stringify(box.policy.allow['github.com'])
    expect(githubRules).toContain(bobPh)
    const sync = t.h.vercel.commands.filter((c) => c.command === MEMBERS_COMMAND).at(-1)!
    const members = JSON.parse(Buffer.from(sync.env.ORCA_MEMBERS_B64!, 'base64').toString())
    // orca-git-identity maps orcad's attested sender device to the member (bob's grant device here).
    expect(members.find((m: { userId: string }) => m.userId === 'bob').deviceIds).toEqual([
      [...t.h.vercel.boxes.values()][0]!.devices.at(-1)
    ])
    expect(members.map((m: { userId: string; email: string }) => [m.userId, m.email])).toEqual([
      ['alice', '11+alice-gh@users.noreply.github.com'],
      ['bob', '22+bob-gh@users.noreply.github.com']
    ])
    expect(JSON.stringify(members)).not.toContain('ghs_')
    expect((await t.proxied('github.com', '/acme/app.git/info/refs', bobPh)).status).toBe(200)

    await t.h.call('DELETE', `/v1/team/workspaces/${t.id}/grants/${issued.body.grant.id}`, { bearer: bob })
    expect(JSON.stringify(box.policy.allow['github.com'])).not.toContain(bobPh)
    expect(await t.proxied('github.com', '/acme/app.git/info/refs', bobPh)).toEqual({ status: 403, body: 'placeholder_missing' })
  })

  it('MEMBER_GIT_IDENTITY=off turns it off: member placeholders get no credential, the VM no member configs', async () => {
    const t = await setup('off')
    await t.seed('alice', 'alice-gh', 11)
    const alicePh = await memberPlaceholder(t.id, 'alice')
    expect(await t.proxied('github.com', '/acme/app.git/git-receive-pack', gitBasicAuthorization(alicePh))).toEqual({ status: 403, body: 'credential_unavailable' })
    expect(t.h.vercel.commands.some((c) => c.command === MEMBERS_COMMAND)).toBe(false)
  })

  it('honors a member identity only within the window after their own client reported a send', async () => {
    const t = await setup()
    await t.seed('alice', 'alice-gh', 11, false)
    const ph = gitBasicAuthorization(await memberPlaceholder(t.id, 'alice'))
    // Connected, but never sent: nothing in the VM can use Alice's identity.
    expect(await t.proxied('github.com', '/acme/app.git/git-receive-pack', ph)).toEqual({ status: 403, body: 'credential_unavailable' })
    await t.sent('alice')
    expect((await t.proxied('github.com', '/acme/app.git/git-receive-pack', ph)).status).toBe(200)
    t.h.advance(31 * 60_000)
    expect(await t.proxied('github.com', '/acme/app.git/git-receive-pack', ph)).toEqual({ status: 403, body: 'credential_unavailable' })
    // A teammate cannot open Alice's window for her.
    expect((await t.h.call('POST', `/v1/team/workspaces/${t.id}/sent`, { bearer: await t.as('bob') })).status).toBe(200)
    expect(await t.proxied('github.com', '/acme/app.git/git-receive-pack', ph)).toEqual({ status: 403, body: 'credential_unavailable' })
  })
})
