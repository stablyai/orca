import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose'
import { describe, expect, it } from 'vitest'
import { generateGrantRecipientKey } from '../../../../src/main/cloud-workspaces/sealed-grant-node'
import { memberPlaceholder } from '../src/github-user-tokens'
import { MEMBERS_COMMAND } from '../src/lifecycle'
import { githubActingViews } from '../src/git-actor'
import { memberCoauthors } from '../src/member-git'
import { getSandbox } from '../src/store'
import { gitBasicAuthorization } from '../src/network-policy'
import { createHarness } from './harness'

const PROXY_URL = 'https://sandbox.test/v1/egress/proxy'
const ISSUER = 'https://oidc.vercel.com/team_orca'
const KEK = Buffer.alloc(32, 7).toString('base64')
const OP = 'o'.repeat(40)
const REPO = 'https://github.com/acme/app'

async function setup(memberGit: string | undefined = undefined, extra: Record<string, string> = {}) {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'v1', alg: 'RS256' }] }
  const upstream: { url: string; authorization: string | null }[] = []
  const h = await createHarness(
    { EGRESS_PROXY_URL: PROXY_URL, SECRETS_KEK: KEK, OPERATOR_TOKEN: OP, ...(memberGit ? { MEMBER_GIT_IDENTITY: memberGit } : {}), ...extra },
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
    // GH-AS-MEMBER: outside the repository the member's gh goes out on the App's installation token, never theirs.
    expect((await t.proxied('api.github.com', '/user/repos', `Bearer ${alicePh}`)).status).toBe(200)
    expect(t.upstream.at(-1)!.authorization).toBe('Bearer ghs_app')
    // A teammate without a grant has no route at all, even if connected.
    await t.seed('bob', 'bob-gh', 22)
    const bobPh = await memberPlaceholder(t.id, 'bob')
    expect(await t.proxied('github.com', '/acme/app.git/git-receive-pack', gitBasicAuthorization(bobPh))).toEqual({ status: 403, body: 'placeholder_missing' })
  })

  it('adds a member to the policy and the VM git configs when they get a grant, and drops them on revoke', async () => {
    const t = await setup()
    await t.seed('alice', 'alice-gh', 11)
    // Bob's send comes after Alice's: in a shared workspace the latest sender acts (memberMayAct).
    t.h.advance(1_000)
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

  it('GIT-COAUTHOR: a connected member whose identity cannot be used is sent as a co-author only, never a token', async () => {
    const t = await setup()
    await t.seed('alice', 'alice-gh', 11)
    t.h.advance(1_000)
    await t.seed('bob', 'bob-gh', 22)
    const bob = await t.as('bob')
    const issued = await t.h.call('POST', `/v1/team/workspaces/${t.id}/grants`, {
      bearer: bob,
      body: { recipientPublicKeyB64: generateGrantRecipientKey().publicKeyB64, deviceLabel: 'b', deviceKind: 'desktop' }
    })
    expect(issued.status).toBe(200)
    const sync = t.h.vercel.commands.filter((c) => c.command === MEMBERS_COMMAND).at(-1)!
    // Both usable: no co-authors.
    expect(JSON.parse(Buffer.from(sync.env.ORCA_COAUTHORS_B64!, 'base64').toString())).toEqual([])
    const row = (await getSandbox(t.h.env.SANDBOX_DB, t.id))!
    const coauthors = await memberCoauthors(t.h.env.SANDBOX_DB, row, new Set(['alice']))
    expect(coauthors).toEqual([
      { userId: 'bob', coauthor: 'bob-gh name <22+bob-gh@users.noreply.github.com>', deviceIds: [[...t.h.vercel.boxes.values()][0]!.devices.at(-1)] }
    ])
    expect(JSON.stringify(coauthors)).not.toContain('ghs_')
  })

  it('MEMBER_GIT_IDENTITY=off turns it off: member placeholders get no credential, the VM no member configs', async () => {
    const t = await setup('off')
    await t.seed('alice', 'alice-gh', 11)
    const alicePh = await memberPlaceholder(t.id, 'alice')
    expect(await t.proxied('github.com', '/acme/app.git/git-receive-pack', gitBasicAuthorization(alicePh))).toEqual({ status: 403, body: 'credential_unavailable' })
    expect(t.h.vercel.commands.some((c) => c.command === MEMBERS_COMMAND)).toBe(false)
  })

  it('the only person who can use the workspace acts as themselves without a send, with no expiry (GH-AS-MEMBER)', async () => {
    const t = await setup()
    await t.seed('alice', 'alice-gh', 11, false)
    const ph = gitBasicAuthorization(await memberPlaceholder(t.id, 'alice'))
    expect((await t.proxied('github.com', '/acme/app.git/git-receive-pack', ph)).status).toBe(200)
    t.h.advance(31 * 60_000)
    expect((await t.proxied('github.com', '/acme/app.git/git-receive-pack', ph)).status).toBe(200)
    // A teammate's send changes nothing for a workspace they can't use (no grant).
    expect((await t.h.call('POST', `/v1/team/workspaces/${t.id}/sent`, { bearer: await t.as('bob') })).status).toBe(200)
    expect((await t.proxied('github.com', '/acme/app.git/git-receive-pack', ph)).status).toBe(200)
  })
})

describe('GIT-ACTOR: githubActing and you on the workspace view (list and detail)', () => {
  const detail = async (t: Awaited<ReturnType<typeof setup>>, user: string) =>
    (await t.h.call('GET', `/v1/team/workspaces/${t.id}`, { bearer: await t.as(user) })).body.workspace
  const listed = async (t: Awaited<ReturnType<typeof setup>>, user: string) =>
    (await t.h.call('GET', '/v1/team/workspaces', { bearer: await t.as(user) })).body.workspaces.find((w: { id: string }) => w.id === t.id)

  it('solo: the owner once connected, uncapped; "off" with GH_AS_MEMBER off', async () => {
    const t = await setup(undefined, { GH_AS_MEMBER: 'on' })
    expect(await detail(t, 'alice')).toMatchObject({ githubActing: { actingAs: 'bot', reason: 'sender_not_connected' }, you: { connected: false } })
    await t.seed('alice', 'alice-gh', 11, false)
    const solo = await detail(t, 'alice')
    expect(solo.githubActing).toEqual({ actingAs: 'member', userId: 'alice', login: 'alice-gh' })
    expect(solo.you).toEqual({ connected: true, login: 'alice-gh' })
    expect((await listed(t, 'alice')).githubActing).toEqual(solo.githubActing)
    // Expired with no refresh token: reconnect.
    t.h.advance(2 * 60 * 60_000)
    expect((await detail(t, 'alice')).githubActing).toEqual({ actingAs: 'bot', reason: 'reconnect' })
    const off = await setup()
    await off.seed('alice', 'alice-gh', 11, false)
    expect((await detail(off, 'alice')).githubActing).toEqual({ actingAs: 'bot', reason: 'off' })
  })

  it('shared: the latest sender until the 60 min window lapses (until), then window_expired', async () => {
    const t = await setup(undefined, { GH_AS_MEMBER: 'on' })
    await t.seed('alice', 'alice-gh', 11, false)
    const bob = await t.as('bob')
    const issued = await t.h.call('POST', `/v1/team/workspaces/${t.id}/grants`, {
      bearer: bob,
      body: { recipientPublicKeyB64: generateGrantRecipientKey().publicKeyB64, deviceLabel: 'b', deviceKind: 'desktop' }
    })
    expect(issued.status).toBe(200)
    expect((await detail(t, 'bob')).githubActing).toEqual({ actingAs: 'bot', reason: 'no_sender_yet' })
    await t.sent('alice')
    const sentAt = t.h.now()
    const shared = await detail(t, 'bob')
    expect(shared.githubActing).toEqual({ actingAs: 'member', userId: 'alice', login: 'alice-gh', until: sentAt + 60 * 60_000 })
    // Bob isn't connected: only he is shown the connect prompt.
    expect(shared.you).toEqual({ connected: false })
    t.h.advance(1_000)
    await t.sent('bob')
    expect((await detail(t, 'alice')).githubActing).toEqual({ actingAs: 'bot', reason: 'sender_not_connected' })
    t.h.advance(1_000)
    await t.sent('alice')
    t.h.advance(61 * 60_000)
    expect((await detail(t, 'alice')).githubActing).toEqual({ actingAs: 'bot', reason: 'window_expired' })
  })

  it('the list reads a fixed number of times whatever its size (no per-row lookups)', async () => {
    const t = await setup(undefined, { GH_AS_MEMBER: 'on' })
    await t.seed('alice', 'alice-gh', 11, false)
    const db = t.h.env.SANDBOX_DB
    let reads = 0
    const counting = new Proxy(db, {
      get: (target, prop) => (prop === 'prepare' ? (sql: string) => (reads++, target.prepare(sql)) : Reflect.get(target, prop, target))
    }) as D1Database
    const row = (await getSandbox(db, t.id))!
    // Four rows of the same owner (ids differ): a list of any size.
    const results = [row, ...[1, 2, 3].map((n) => ({ ...row, id: `${row.id}-copy${n}` }))]
    const options = { enabled: () => true, sharedMaxMs: 60 * 60_000 }
    const views = await githubActingViews(counting, results as never, 'alice', t.h.now(), options)
    expect([...views.values()].map((v) => v.githubActing)).toEqual(Array(4).fill({ actingAs: 'member', userId: 'alice', login: 'alice-gh' }))
    // grants + sends + one connections read for the account.
    expect(reads).toBe(3)
  })
})

