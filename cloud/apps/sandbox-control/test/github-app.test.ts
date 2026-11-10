import { exportPKCS8, generateKeyPair, decodeJwt } from 'jose'
import { describe, expect, it } from 'vitest'
import { createGitHubAppMinter } from '../src/github-app'
import { bindInstallation, isInstallationBound, signState, verifyState } from '../src/github-connect'
import { gitBasicAuthorization } from '../src/network-policy'
import { START_COMMAND } from '../src/sandbox-vm-commands'
import { createHarness } from './harness'

const MIN = 60_000
const REPO = 'https://github.com/alice-gh/private-repo.git'
const STATE_SECRET = 's'.repeat(40)
const OPERATOR = 'o'.repeat(40)

type Call = { method: string; path: string; body: unknown; auth: string | null }

/** Fake api.github.com + github.com OAuth: alice-gh (id 1) owns installation 77 on her personal account. */
function fakeGitHub(options: { now: () => number; users?: Record<string, { id: number; login: string; installations: unknown[]; memberships?: Record<string, unknown> }> }) {
  const calls: Call[] = []
  const users = options.users ?? {
    code_alice: { id: 1, login: 'alice-gh', installations: [{ id: 77, account: { id: 1, login: 'alice-gh', type: 'User' } }] },
    code_mallory: { id: 666, login: 'mallory-gh', installations: [] }
  }
  const tokens = new Map<string, keyof typeof users>()
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const auth = new Headers(init?.headers).get('authorization')
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, body, auth })
    if (url.hostname === 'github.com' && url.pathname === '/login/oauth/access_token') {
      const user = users[body.code]
      if (!user) {
        return Response.json({ error: 'bad_verification_code' })
      }
      const token = `gho_${body.code}`
      tokens.set(token, body.code)
      return Response.json({ access_token: token })
    }
    const userToken = auth?.startsWith('Bearer gho_') ? users[tokens.get(auth.slice(7)) ?? ''] : undefined
    if (url.pathname === '/user') {
      return userToken ? Response.json({ id: userToken.id, login: userToken.login }) : new Response(null, { status: 401 })
    }
    if (url.pathname === '/user/installations') {
      return Response.json({ total_count: userToken!.installations.length, installations: userToken!.installations })
    }
    if (url.pathname.startsWith('/user/memberships/orgs/')) {
      const membership = userToken?.memberships?.[url.pathname.split('/').pop()!]
      return membership ? Response.json(membership) : new Response(null, { status: 404 })
    }
    // App-JWT routes: the repo is installed under installation 77 regardless of who asks.
    if (url.pathname === '/repos/alice-gh/private-repo/installation' || url.pathname === '/app/installations/77') {
      return Response.json({ id: 77, account: { id: 1, login: 'alice-gh', type: 'User' } })
    }
    if (url.pathname === '/app/installations/77/access_tokens') {
      return Response.json({
        token: `ghs_${calls.length}`,
        expires_at: new Date(options.now() + 60 * MIN).toISOString(),
        repositories: body.repositories.map((name: string) => ({ id: 9, name }))
      })
    }
    return new Response(null, { status: 404 })
  }) as typeof globalThis.fetch
  return { calls, fetch: fakeFetch }
}

async function appKey() {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true })
  return exportPKCS8(privateKey)
}

async function harnessWithApp() {
  let clock = () => 0
  const github = fakeGitHub({ now: () => clock() })
  const pem = await appKey()
  let dbRef: D1Database | null = null
  const minter = createGitHubAppMinter({
    appId: '123',
    privateKeyPkcs8: pem,
    fetch: github.fetch,
    now: () => clock(),
    isBound: (id, account) => isInstallationBound(dbRef!, id, account),
    log: () => undefined
  })
  const h = await createHarness(
    {
      GITHUB_APP_SLUG: 'orca-cloud-test',
      GITHUB_APP_CLIENT_ID: 'Iv1.test',
      GITHUB_APP_CLIENT_SECRET: 'client-secret',
      GITHUB_STATE_SECRET: STATE_SECRET,
      OPERATOR_TOKEN: OPERATOR,
      EGRESS_PROXY_URL: 'https://sandbox.test/v1/egress/proxy'
    },
    { github: minter, githubFetch: github.fetch }
  )
  clock = h.now
  dbRef = h.env.SANDBOX_DB
  return { h, github, minter }
}

async function browser(h: Awaited<ReturnType<typeof createHarness>>, url: string) {
  const response = await h.send(new Request(url))
  return { status: response.status, location: response.headers.get('location'), text: await response.text() }
}

/** Desktop asks for a connect URL, the browser installs + signs in on GitHub as `code`'s user. */
async function connect(h: Awaited<ReturnType<typeof createHarness>>, as: string, code: string, installationId = 77) {
  const { body } = await h.call('POST', '/v1/github/connect', { as })
  const state = new URL(body.installUrl).searchParams.get('state')!
  const setup = await browser(h, `https://sandbox.test/v1/github/setup?installation_id=${installationId}&setup_action=install&state=${encodeURIComponent(state)}`)
  expect(setup.status).toBe(302)
  const authorize = new URL(setup.location!)
  expect(authorize.origin + authorize.pathname).toBe('https://github.com/login/oauth/authorize')
  expect(authorize.searchParams.get('redirect_uri')).toBe('https://sandbox.test/v1/github/callback')
  const carried = authorize.searchParams.get('state')!
  const callback = await browser(h, `https://sandbox.test/v1/github/callback?code=${code}&state=${encodeURIComponent(carried)}`)
  return { state, carried, callback, body }
}

describe('GitHub App installation tokens', () => {
  it('mints a single-repo token only for a bound account, and re-checks the binding on cached tokens', async () => {
    let now = Date.parse('2026-11-09T00:00:00Z')
    const github = fakeGitHub({ now: () => now })
    const bound = new Set(['77:user:alice'])
    const minter = createGitHubAppMinter({
      appId: '123',
      privateKeyPkcs8: await appKey(),
      now: () => now,
      fetch: github.fetch,
      isBound: async (id, account) => bound.has(`${id}:${account}`),
      log: () => undefined
    })
    const token = await minter.tokenForRepo(REPO, 'user:alice')
    expect(token).toMatchObject({ expiresAt: now + 60 * MIN })
    expect(github.calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ['GET', '/repos/alice-gh/private-repo/installation', undefined],
      [
        'POST',
        '/app/installations/77/access_tokens',
        { repositories: ['private-repo'], permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' } }
      ]
    ])
    expect(decodeJwt(github.calls[0]!.auth!.slice(7)).iss).toBe('123')

    // Cross-tenant: another account naming the same repo gets nothing, and no token is minted.
    expect(await minter.tokenForRepo(REPO, 'user:bob')).toBeNull()
    expect(github.calls.filter((c) => c.path.endsWith('/access_tokens'))).toHaveLength(1)

    now += 30 * MIN
    expect(await minter.tokenForRepo('https://github.com/alice-gh/private-repo', 'user:alice')).toEqual(token)
    bound.delete('77:user:alice')
    expect(await minter.tokenForRepo(REPO, 'user:alice')).toBeNull()

    expect(await minter.tokenForRepo('https://gitlab.com/a/b', 'user:alice')).toBeNull()
    expect(await minter.tokenForRepo('https://x:y@github.com/alice-gh/private-repo', 'user:alice')).toBeNull()
  })

  it('asks for issues:write only for routine comments, cached apart, and falls back when the installation lacks it', async () => {
    const now = Date.parse('2026-11-09T00:00:00Z')
    const github = fakeGitHub({ now: () => now })
    let issuesAccepted = false
    const fetchWithIssues = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      if (String(input).endsWith('/access_tokens') && body?.permissions?.issues && !issuesAccepted) {
        return Response.json({ message: 'The permissions requested are not granted to this installation.' }, { status: 422 })
      }
      return github.fetch(input, init)
    }) satisfies typeof fetch
    const minter = createGitHubAppMinter({
      appId: '123',
      privateKeyPkcs8: await appKey(),
      now: () => now,
      fetch: fetchWithIssues,
      isBound: async () => true,
      log: () => undefined
    })
    // Not accepted yet: the standard token comes back (PR comments still work).
    expect(await minter.tokenForRepo(REPO, 'user:alice', { issues: true })).not.toBeNull()
    issuesAccepted = true
    const issues = await minter.tokenForRepo('https://github.com/alice-gh/other-repo', 'user:alice', { issues: true })
    expect(issues).toBeNull() // other-repo is not installed in the fake
    const plain = await minter.tokenForRepo(REPO, 'user:alice')
    const withIssues = await minter.tokenForRepo(REPO, 'user:alice', { issues: true })
    expect(withIssues).not.toBeNull()
    expect(withIssues!.token).not.toBe(plain!.token)
    const mints = github.calls.filter((c) => c.path.endsWith('/access_tokens')).map((c) => (c.body as { permissions: Record<string, string> }).permissions)
    expect(mints.at(-1)).toEqual({ contents: 'write', pull_requests: 'write', metadata: 'read', issues: 'write' })
  })

  it('refuses a minted token that covers more than the one repository', async () => {
    const minter = createGitHubAppMinter({
      appId: '123',
      privateKeyPkcs8: await appKey(),
      isBound: async () => true,
      fetch: (async (input: RequestInfo | URL) =>
        String(input).endsWith('/installation')
          ? Response.json({ id: 77, account: { id: 1, login: 'alice-gh', type: 'User' } })
          : Response.json({ token: 'ghs_wide', expires_at: new Date().toISOString(), repositories: [{ id: 1, name: 'private-repo' }, { id: 2, name: 'other' }] })) as typeof fetch
    })
    await expect(minter.tokenForRepo(REPO, 'user:alice')).rejects.toThrow('unexpected scope')
  })

  it('cross-tenant attack: bob names alice’s repo and gets no credential and no token is minted', async () => {
    const { h, github } = await harnessWithApp()
    await bindInstallation(
      h.env.SANDBOX_DB,
      {
        installation_id: 77,
        account_id: 'user:alice',
        github_account_id: 1,
        github_account_login: 'alice-gh',
        github_account_type: 'User',
        bound_by_user_id: 'alice',
        bound_by_github_user_id: 1,
        method: 'oauth'
      },
      h.now()
    )
    const res = await h.call('POST', '/v1/sandboxes', { as: 'bob', body: { workspaceId: 'ws-steal', machineSize: 'standard', repo: { url: REPO } } })
    expect(res.status).toBe(200)
    const [box] = [...h.vercel.boxes.values()]
    expect(box!.policy.allow['github.com'] ?? []).toEqual([])
    expect(h.vercel.commands.find((c) => c.command === START_COMMAND)!.env.ORCA_GIT_EXTRAHEADER).toBeUndefined()
    expect(github.calls.filter((c) => c.path.endsWith('/access_tokens'))).toHaveLength(0)

    // Alice, bound, gets her token.
    const mine = await h.call('POST', '/v1/sandboxes', { as: 'alice', body: { workspaceId: 'ws-mine', machineSize: 'standard', repo: { url: REPO } } })
    const aliceBox = h.vercel.boxes.get(`orca-test-${mine.body.sandbox.id}`)!
    expect(aliceBox.policy.allow['github.com']![0]).toMatchObject({
      transform: [{ headers: { authorization: expect.stringMatching(/^Basic /) } }]
    })
    expect(github.calls.filter((c) => c.path.endsWith('/access_tokens'))).toHaveLength(1)
  })

  it('binds an installation only after GitHub proves the installer owns it, single use', async () => {
    const { h, minter } = await harnessWithApp()
    const { state, carried, callback, body } = await connect(h, 'alice', 'code_alice')
    expect(body.installUrl).toMatch(/^https:\/\/github\.com\/apps\/orca-cloud-test\/installations\/new\?state=/)
    expect(callback.text).toContain('Connected GitHub <b>alice-gh</b>')
    expect(await minter.tokenForRepo(REPO, 'user:alice')).not.toBeNull()
    expect(await minter.tokenForRepo(REPO, 'user:bob')).toBeNull()
    expect((await h.call('GET', '/v1/github/installations', { as: 'alice' })).body.installations).toMatchObject([
      { installationId: 77, account: 'alice-gh', accountType: 'User' }
    ])
    expect((await h.call('GET', '/v1/github/installations', { as: 'bob' })).body.installations).toEqual([])

    // Replaying the callback (or the original state) binds nothing more.
    const replay = await browser(h, `https://sandbox.test/v1/github/callback?code=code_alice&state=${encodeURIComponent(carried)}`)
    expect(replay.text).toContain('already used')
    expect(state).not.toBe(carried)
  })

  it('attack: mallory starts her own connect and points the setup URL at alice’s installation id', async () => {
    const { h, minter } = await harnessWithApp()
    const { callback } = await connect(h, 'mallory', 'code_mallory', 77)
    expect(callback.text).toContain('Nothing was connected')
    expect(await minter.tokenForRepo(REPO, 'user:mallory')).toBeNull()
    expect(h.raw.prepare('SELECT COUNT(*) AS n FROM github_installations').get()).toEqual({ n: 0 })
  })

  it('attack: a forged or tampered state (another account, no signature) is refused', async () => {
    const { h } = await harnessWithApp()
    const { body } = await h.call('POST', '/v1/github/connect', { as: 'mallory' })
    const state = new URL(body.installUrl).searchParams.get('state')!
    const payload = await verifyState(STATE_SECRET, state, h.now())
    const [bodyPart, mac] = state.split('.')
    const forged = `${btoa(JSON.stringify({ ...payload, a: 'user:alice' })).replace(/=+$/, '')}.${mac}`
    expect(bodyPart).not.toBe(forged.split('.')[0])
    for (const bad of [forged, await signState('x'.repeat(40), payload!), 'garbage']) {
      const res = await browser(h, `https://sandbox.test/v1/github/callback?code=code_alice&state=${encodeURIComponent(bad)}`)
      expect(res.text).toContain('not opened from Orca')
    }
    // A validly signed state whose nonce belongs to another account is refused too.
    const crossed = await signState(STATE_SECRET, { ...payload!, a: 'user:alice' })
    const res = await browser(h, `https://sandbox.test/v1/github/callback?code=code_alice&state=${encodeURIComponent(crossed)}`)
    expect(res.text).toContain('already used')
    expect(h.raw.prepare('SELECT COUNT(*) AS n FROM github_installations').get()).toEqual({ n: 0 })
    h.advance(11 * MIN)
    const expired = await browser(h, `https://sandbox.test/v1/github/callback?code=code_mallory&state=${encodeURIComponent(state)}`)
    expect(expired.text).toContain('not opened from Orca')
  })

  it('org installations bind only for an active org admin', async () => {
    let now = 0
    const org = { id: 77, account: { id: 50, login: 'acme', type: 'Organization' } }
    const github = fakeGitHub({
      now: () => now,
      users: {
        code_member: { id: 2, login: 'member', installations: [org], memberships: { acme: { state: 'active', role: 'member' } } },
        code_admin: { id: 3, login: 'admin', installations: [org], memberships: { acme: { state: 'active', role: 'admin' } } },
        code_pending: { id: 4, login: 'pending', installations: [org], memberships: { acme: { state: 'pending', role: 'admin' } } }
      }
    })
    const h = await createHarness(
      { GITHUB_APP_SLUG: 'orca-cloud-test', GITHUB_APP_CLIENT_ID: 'Iv1.test', GITHUB_APP_CLIENT_SECRET: 'x', GITHUB_STATE_SECRET: STATE_SECRET },
      { githubFetch: github.fetch }
    )
    now = h.now()
    for (const [code, expected] of [['code_member', 0], ['code_pending', 0], ['code_admin', 1]] as const) {
      const { callback } = await connect(h, 'carol', code)
      expect(callback.status).toBe(200)
      expect(h.raw.prepare(`SELECT COUNT(*) AS n FROM github_installations WHERE account_id = 'user:carol'`).get()).toEqual({ n: expected })
    }
  })

  it('operator binding needs the operator token and is recorded as such', async () => {
    const { h, minter } = await harnessWithApp()
    const bind = (token: string) =>
      h.send(
        new Request('https://sandbox.test/v1/internal/github/bindings', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ installationId: 77, accountId: 'dev:push' })
        })
      )
    expect((await bind(await h.token('alice'))).status).toBe(404)
    expect((await bind('o'.repeat(39) + 'x')).status).toBe(404)
    const ok = await bind(OPERATOR)
    expect(await ok.json()).toEqual({ bound: { installationId: 77, accountId: 'dev:push', githubAccount: 'alice-gh' } })
    expect(h.raw.prepare('SELECT method, bound_by_user_id FROM github_installations').get()).toEqual({ method: 'operator', bound_by_user_id: 'operator' })
    expect(await minter.tokenForRepo(REPO, 'dev:push')).not.toBeNull()
    const byRepo = await h.send(
      new Request('https://sandbox.test/v1/internal/github/bindings', {
        method: 'POST',
        headers: { authorization: `Bearer ${OPERATOR}` },
        body: JSON.stringify({ repoUrl: REPO, accountId: 'dev:other' })
      })
    )
    expect(await byRepo.json()).toEqual({ bound: { installationId: 77, accountId: 'dev:other', githubAccount: 'alice-gh' } })
    const unbind = await h.send(
      new Request('https://sandbox.test/v1/internal/github/bindings', {
        method: 'DELETE',
        headers: { authorization: `Bearer ${OPERATOR}` },
        body: JSON.stringify({ installationId: 77, accountId: 'dev:push' })
      })
    )
    expect(await unbind.json()).toEqual({ revoked: 1 })
    expect(await minter.tokenForRepo(REPO, 'dev:push')).toBeNull()
  })

  it('injects the repo token for git and refreshes it before it expires', async () => {
    let expiresAt = 0
    const h = await createHarness({}, {
      github: { tokenForRepo: async () => ({ token: `ghs_${expiresAt}`, expiresAt }), getInstallation: async () => null, getRepoInstallation: async () => null }
    })
    expiresAt = h.now() + 60 * MIN
    const { body } = await h.call('POST', '/v1/sandboxes', {
      body: { workspaceId: 'ws-git', machineSize: 'standard', repo: { url: 'https://github.com/nwparker/orca-sandbox-push-test.git' } }
    })
    const placeholder = gitBasicAuthorization(`orca-ph-${body.sandbox.id}`)
    const [box] = [...h.vercel.boxes.values()]
    expect(box!.policy.allow['github.com']![0]).toEqual({
      match: { headers: [{ key: { exact: 'authorization' }, value: { exact: placeholder } }] },
      transform: [{ headers: { authorization: gitBasicAuthorization(`ghs_${expiresAt}`) } }]
    })
    const start = h.vercel.commands.find((c) => c.command === START_COMMAND)!
    expect(start.env.ORCA_GIT_EXTRAHEADER).toBe(`Authorization: ${placeholder}`)
    expect(start.env.ORCA_REPO_URL).toBe('https://github.com/nwparker/orca-sandbox-push-test.git')

    const first = expiresAt
    h.advance(50 * MIN)
    expiresAt = h.now() + 60 * MIN
    await h.reconcile()
    expect(box!.policy.allow['github.com']![0]).toMatchObject({ transform: [{ headers: { authorization: gitBasicAuthorization(`ghs_${expiresAt}`) } }] })
    expect(expiresAt).not.toBe(first)
  })
})
