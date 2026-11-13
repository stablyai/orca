import { exportPKCS8, generateKeyPair } from 'jose'
import { describe, expect, it } from 'vitest'
import { createGitHubAppMinter } from '../src/github-app'
import { installUrl, isInstallationBound } from '../src/github-connect'
import type { SetupNotice } from '../src/github-repo-access'
import { storeUserToken } from '../src/github-user-tokens'
import { keyringFor } from '../src/secrets'
import { createHarness } from './harness'
import {
  HostedGithubRepoAccessResponseSchema,
  HostedGithubRepositoriesResponseSchema
} from '../../../../src/shared/hosted-sandbox/hosted-github-wire'

const STATE_SECRET = 's'.repeat(40)
const HOOK_SECRET = 'w'.repeat(40)
const CONTROL_PLANE_TOKEN = 'c'.repeat(40)
const REPO = 'https://github.com/acme/web'
const SESSION = 'cs_abcdefghijklmnopqrstuv'
const MIN = 60_000

type Installation = { id: number; account: { id: number; login: string; type: 'User' | 'Organization' }; repos: string[] }

/**
 * Fake github.com: acme (org id 50) has admin `admin-gh` (id 3) and member `sam-gh` (id 2). Tests
 * install the App on acme by pushing to `installations`, and queue install requests in `requests`.
 */
function fakeGitHub() {
  const installations: Installation[] = []
  const requests: { account: { login: string }; requester: { id: number } }[] = []
  const users: Record<string, { id: number; login: string; memberships: Record<string, unknown> }> = {
    code_admin: { id: 3, login: 'admin-gh', memberships: { acme: { state: 'active', role: 'admin' } } },
    code_sam: { id: 2, login: 'sam-gh', memberships: { acme: { state: 'active', role: 'member' } } },
    code_alice: { id: 7, login: 'Alice-GH', memberships: {} }
  }
  // Fault injection for GET /user/memberships/orgs/*.
  const faults: { membership?: 'error' | 'hang' | 'forbidden'; users?: 'error' | 'hang' } = {}
  const orgs: Record<string, number> = { acme: 50, 'other-org': 51 }
  const tokens = new Map<string, string>()
  const calls: string[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const auth = new Headers(init?.headers).get('authorization') ?? ''
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)
    if (url.hostname === 'github.com' && url.pathname === '/login/oauth/access_token' && body.grant_type === 'refresh_token') {
      const code = String(body.refresh_token).replace(/^ghr_/, '')
      tokens.set(`gho_fresh_${code}`, code)
      return Response.json({ access_token: `gho_fresh_${code}`, refresh_token: `ghr_${code}`, expires_in: 28_800 })
    }
    if (url.hostname === 'github.com' && url.pathname === '/login/oauth/access_token') {
      const user = users[body.code]
      if (!user) {
        return Response.json({ error: 'bad_verification_code' })
      }
      tokens.set(`gho_${body.code}`, body.code)
      return Response.json({ access_token: `gho_${body.code}` })
    }
    const user = auth.startsWith('Bearer gho_') ? users[tokens.get(auth.slice(7)) ?? ''] : undefined
    if (url.pathname.startsWith('/user/memberships/orgs/') && faults.membership === 'error') {
      return new Response(null, { status: 500 })
    }
    if (url.pathname.startsWith('/user/memberships/orgs/') && faults.membership === 'forbidden') {
      return new Response(null, { status: 403 })
    }
    if (url.pathname.startsWith('/users/') && faults.users === 'error') {
      return new Response(null, { status: 502 })
    }
    if ((url.pathname.startsWith('/user/memberships/orgs/') && faults.membership === 'hang') || (url.pathname.startsWith('/users/') && faults.users === 'hang')) {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))
    }
    if (url.pathname === '/user') {
      return user ? Response.json({ id: user.id, login: user.login }) : new Response(null, { status: 401 })
    }
    if (url.pathname === '/user/installations') {
      return Response.json({ installations: installations.map(({ id, account }) => ({ id, account })) })
    }
    if (url.pathname.startsWith('/user/memberships/orgs/')) {
      const membership = user?.memberships[url.pathname.split('/').pop()!]
      return membership ? Response.json(membership) : new Response(null, { status: 404 })
    }
    const appInstallation = /^\/app\/installations\/(\d+)$/.exec(url.pathname)
    if (appInstallation) {
      const found = installations.find((i) => i.id === Number(appInstallation[1]))
      return found ? Response.json({ id: found.id, account: found.account }) : new Response(null, { status: 404 })
    }
    const orgMembership = /^\/orgs\/([^/]+)\/memberships\/([^/]+)$/.exec(url.pathname)
    if (orgMembership && auth.startsWith('Bearer ghs_inst_')) {
      const member = Object.values(users).find((u) => u.login === orgMembership[2])
      const membership = member?.memberships[orgMembership[1]!]
      return membership ? Response.json({ ...membership, user: { id: member!.id, login: member!.login } }) : new Response(null, { status: 404 })
    }
    const publicUser = /^\/users\/([^/]+)$/.exec(url.pathname)
    if (publicUser) {
      const login = decodeURIComponent(publicUser[1]!).toLowerCase()
      const org = orgs[login]
      const person = Object.values(users).find((u) => u.login.toLowerCase() === login)
      return org
        ? Response.json({ id: org, login, type: 'Organization' })
        : person
          ? Response.json({ id: person.id, login: person.login, type: 'User' })
          : new Response(null, { status: 404 })
    }
    const repoInstall = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(url.pathname)
    if (repoInstall) {
      const found = installations.find((i) => i.repos.includes(`${repoInstall[1]}/${repoInstall[2]}`.toLowerCase()))
      return found ? Response.json({ id: found.id, account: found.account }) : new Response(null, { status: 404 })
    }
    if (url.pathname === '/app/installation-requests') {
      return Response.json(requests)
    }
    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname)
    if (mint) {
      return Response.json({ token: `ghs_inst_${mint[1]}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() })
    }
    if (url.pathname === '/installation/repositories') {
      const id = Number(auth.replace('Bearer ghs_inst_', ''))
      const repos = installations.find((i) => i.id === id)?.repos ?? []
      const page = Number(url.searchParams.get('page') ?? 1)
      const per = Number(url.searchParams.get('per_page') ?? 30)
      return Response.json({
        total_count: repos.length,
        repositories: repos.slice((page - 1) * per, page * per).map((name, n) => ({
          id: 1000 + n,
          full_name: name,
          private: true,
          default_branch: 'main',
          pushed_at: null
        }))
      })
    }
    return new Response(null, { status: 404 })
  }) as typeof globalThis.fetch
  return { installations, requests, calls, faults, tokens, fetch }
}

async function setup(options: { publicRepos?: string[] } = {}) {
  const github = fakeGitHub()
  const { privateKey } = await generateKeyPair('RS256', { extractable: true })
  let dbRef: D1Database | null = null
  let clock = () => 0
  const minter = createGitHubAppMinter({
    appId: '123',
    privateKeyPkcs8: await exportPKCS8(privateKey),
    fetch: github.fetch,
    now: () => clock(),
    isBound: (id, account) => isInstallationBound(dbRef!, id, account),
    log: () => undefined
  })
  const notices: SetupNotice[] = []
  const trialNotices: unknown[] = []
  const h = await createHarness(
    {
      GITHUB_APP_SLUG: 'orca-cloud-test',
      GITHUB_APP_CLIENT_ID: 'Iv1.test',
      GITHUB_APP_CLIENT_SECRET: 'client-secret',
      GITHUB_STATE_SECRET: STATE_SECRET,
      GITHUB_WEBHOOK_SECRET: HOOK_SECRET,
      CONTROL_PLANE_TOKEN,
      CLOUD_SETUP_ORIGIN: 'https://auth.test',
      SECRETS_KEK: Buffer.alloc(32, 7).toString('base64')
    },
    {
      github: minter,
      githubFetch: github.fetch,
      publicRepoCheck: async (url) => (options.publicRepos ?? []).includes(url),
      setupNotifier: async (notice) => {
        notices.push(notice)
      },
      trialNotifier: async (notice) => {
        trialNotices.push(notice)
      }
    }
  )
  clock = h.now
  dbRef = h.env.SANDBOX_DB
  const browser = async (url: string) => {
    const response = await h.send(new Request(url))
    return { status: response.status, location: response.headers.get('location'), text: await response.text() }
  }
  const webhook = async (event: string, payload: unknown) => {
    const text = JSON.stringify(payload)
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(HOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)))
    const response = await h.send(
      new Request('https://sandbox.test/v1/github/webhook', {
        method: 'POST',
        headers: {
          'x-github-event': event,
          'x-github-delivery': `d-${Math.random().toString(36).slice(2, 12)}`,
          'x-hub-signature-256': `sha256=${Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')}`
        },
        body: text
      })
    )
    return { status: response.status, body: (await response.json()) as any }
  }
  return { h, github, notices, trialNotices, browser, webhook }
}

const ACME = { id: 50, login: 'acme', type: 'Organization' as const }
const stateOf = (url: string) => new URL(url).searchParams.get('state')!

describe('GitHub repo access (cloud-start N2/N3, D2)', () => {
  it('answers missing with an install URL, public, then granted once an admin installs and binds', async () => {
    const { h, github, notices, trialNotices, browser } = await setup({ publicRepos: ['https://github.com/acme/site'] })
    expect((await h.call('GET', `/v1/github/repo-access?repo=${encodeURIComponent('https://github.com/acme/site')}`)).body).toEqual({
      access: 'public',
      owner: 'acme',
      repo: 'https://github.com/acme/site',
      // The App isn't on acme yet and alice hasn't connected GitHub: unknown.
      canInstall: null
    })
    const missing = await h.call('GET', `/v1/github/repo-access?repo=${encodeURIComponent(`${REPO}.git`)}&session=${SESSION}`)
    expect(missing.body).toMatchObject({ access: 'missing', owner: 'acme', repo: REPO })
    expect(HostedGithubRepoAccessResponseSchema.parse(missing.body)).toEqual(missing.body)
    // No repository id: the plain page, so GitHub never defaults to "All repositories".
    expect(missing.body.installUrl).toMatch(/^https:\/\/github\.com\/apps\/orca-cloud-test\/installations\/new\?state=/)

    // The owner installs on acme/web; the setup URL round trip proves they're an org admin.
    github.installations.push({ id: 900, account: ACME, repos: ['acme/web'] })
    const setupPage = await browser(`https://sandbox.test/v1/github/setup?installation_id=900&setup_action=install&state=${encodeURIComponent(stateOf(missing.body.installUrl))}`)
    const callback = await browser(`https://sandbox.test/v1/github/callback?code=code_admin&state=${encodeURIComponent(stateOf(setupPage.location!))}`)
    // Back to the setup session's next page, and billing hears the repo is done.
    expect(callback.status).toBe(302)
    expect(callback.location).toBe(`https://auth.test/cloud/setup/next?session=${SESSION}&from=github`)
    expect(notices).toEqual([{ sessionId: SESSION, accountId: 'user:alice', repo: REPO, state: 'done' }])
    // Billing's trial abuse keys: numeric GitHub owner and user ids of the bind.
    expect(trialNotices).toEqual([{ accountId: 'user:alice', githubOwnerId: 50, githubUserId: 3 }])
    expect((await h.call('GET', `/v1/github/repo-access?repo=${encodeURIComponent(REPO)}`)).body).toEqual({ access: 'granted', owner: 'acme', repo: REPO })
    // Another Orca account is not granted by alice's binding.
    expect((await h.call('GET', `/v1/github/repo-access?repo=${encodeURIComponent(REPO)}`, { as: 'bob' })).body.access).toBe('missing')
    expect((await h.call('GET', '/v1/github/repo-access?repo=https%3A%2F%2Fgitlab.com%2Facme%2Fweb')).status).toBe(400)
  })

  it('preselects only the repository with GitHub’s documented suggested_target_id + repository_ids[]', async () => {
    const { h } = await setup()
    const missing = await h.call('GET', `/v1/github/repo-access?repo=${encodeURIComponent(REPO)}&repoId=4242`)
    // ownerId comes from GitHub's public /users/:login.
    expect(missing.body.installUrl).toMatch(
      /^https:\/\/github\.com\/apps\/orca-cloud-test\/installations\/new\/permissions\?suggested_target_id=50&repository_ids\[\]=4242&state=/
    )
    const connect = await h.call('POST', '/v1/github/connect', { body: { repo: REPO, repoId: 4242, ownerId: 50, setupSessionId: SESSION } })
    expect(connect.body.installUrl).toContain('/permissions?suggested_target_id=50&repository_ids[]=4242&state=')
    expect(new URL(connect.body.authorizeUrl).searchParams.get('state')).toBe(stateOf(connect.body.installUrl))
    // No target_id: not a documented install-URL parameter.
    expect(installUrl({ appSlug: 'a', clientId: 'c', clientSecret: 'x', stateSecret: STATE_SECRET }, 'st', { ownerId: 1, repoId: 2 })).not.toMatch(/[?&]target_id=/)
    expect(installUrl({ appSlug: 'a', clientId: 'c', clientSecret: 'x', stateSecret: STATE_SECRET }, 'st', { ownerId: 0, repoId: 2 })).toBe(
      'https://github.com/apps/a/installations/new?state=st'
    )
  })

  it('a member’s request waits for an owner (requested), then the installation webhook binds it and finishes setup', async () => {
    const { h, github, notices, trialNotices, browser, webhook } = await setup()
    const missing = await h.call('GET', `/v1/github/repo-access?repo=${encodeURIComponent(REPO)}&session=${SESSION}`, { as: 'sam' })
    // GitHub's Request button returns to the setup URL with setup_action=request and no installation.
    const setupPage = await browser(`https://sandbox.test/v1/github/setup?setup_action=request&state=${encodeURIComponent(stateOf(missing.body.installUrl))}`)
    expect(new URL(setupPage.location!).pathname).toBe('/login/oauth/authorize')
    github.requests.push({ account: { login: 'acme' }, requester: { id: 2 } })
    const callback = await browser(`https://sandbox.test/v1/github/callback?code=code_sam&state=${encodeURIComponent(stateOf(setupPage.location!))}`)
    expect(callback.location).toBe(`https://auth.test/cloud/setup/next?session=${SESSION}&from=github`)
    expect(notices).toEqual([{ sessionId: SESSION, accountId: 'user:sam', repo: REPO, state: 'pending' }])
    expect((await h.call('GET', `/v1/github/repo-access?repo=${encodeURIComponent(REPO)}`, { as: 'sam' })).body.access).toBe('requested')
    // The request was OAuth-proven, so sam's GitHub identity is connected for commits too.
    expect((await h.call('GET', '/v1/github/user', { as: 'sam' })).body).toEqual({ connected: true, login: 'sam-gh', githubUserId: 2 })
    // Nobody else's request: bob still sees missing.
    expect((await h.call('GET', `/v1/github/repo-access?repo=${encodeURIComponent(REPO)}`, { as: 'bob' })).body.access).toBe('missing')

    // An owner approves: GitHub creates the installation and names sam-gh as the requester.
    github.installations.push({ id: 901, account: ACME, repos: ['acme/web'] })
    github.requests.length = 0
    const created = await webhook('installation', {
      action: 'created',
      installation: { id: 901, account: ACME },
      requester: { id: 2, login: 'sam-gh' },
      sender: { id: 3, login: 'admin-gh', type: 'User' },
      repository_selection: 'selected',
      repositories: [{ full_name: 'acme/web' }]
    })
    expect(created.status).toBe(202)
    expect(created.body.installation).toMatchObject({ handled: 'created', bound: 1, notified: 1 })
    expect(notices.at(-1)).toEqual({ sessionId: SESSION, accountId: 'user:sam', repo: REPO, state: 'done' })
    expect(trialNotices).toEqual([{ accountId: 'user:sam', githubUserId: 2, githubOwnerId: 50 }])
    expect((await h.call('GET', `/v1/github/repo-access?repo=${encodeURIComponent(REPO)}`, { as: 'sam' })).body.access).toBe('granted')
    expect(h.raw.prepare(`SELECT method, bound_by_github_user_id AS gh FROM github_installations WHERE installation_id = 901`).all()).toEqual([
      { method: 'request', gh: 2 }
    ])
  })

  it('attack: an installation webhook naming a requester who never asked from Orca binds nothing', async () => {
    const { h, webhook } = await setup()
    const created = await webhook('installation', {
      action: 'created',
      installation: { id: 902, account: ACME },
      requester: { id: 2 },
      sender: { id: 3, type: 'User' },
      repository_selection: 'all'
    })
    expect(created.body.installation).toMatchObject({ bound: 0 })
    expect(h.raw.prepare('SELECT COUNT(*) AS n FROM github_installations').get()).toEqual({ n: 0 })
  })

  it('an owner declining (request gone on GitHub) falls back to missing; requests expire', async () => {
    const { h, github, browser } = await setup()
    const missing = await h.call('GET', `/v1/github/repo-access?repo=${encodeURIComponent(REPO)}`, { as: 'sam' })
    const setupPage = await browser(`https://sandbox.test/v1/github/setup?setup_action=request&state=${encodeURIComponent(stateOf(missing.body.installUrl))}`)
    const page = await browser(`https://sandbox.test/v1/github/callback?code=code_sam&state=${encodeURIComponent(stateOf(setupPage.location!))}`)
    expect(page.text).toContain('GitHub sent your request to an owner of <b>acme</b>')
    expect((await h.call('GET', `/v1/github/repo-access?repo=${encodeURIComponent(REPO)}`, { as: 'sam' })).body.access).toBe('missing')
    github.requests.push({ account: { login: 'acme' }, requester: { id: 2 } })
    h.advance(2 * MIN)
    expect((await h.call('GET', `/v1/github/repo-access?repo=${encodeURIComponent(REPO)}`, { as: 'sam' })).body.access).toBe('requested')
    h.advance(31 * 24 * 60 * MIN)
    expect((await h.call('GET', `/v1/github/repo-access?repo=${encodeURIComponent(REPO)}`, { as: 'sam' })).body.access).toBe('missing')
  })

  it('installation.deleted revokes bindings; installation_repositories.added notifies bound accounts', async () => {
    const { h, github, notices, browser, webhook } = await setup()
    github.installations.push({ id: 900, account: ACME, repos: ['acme/web'] })
    const missing = await h.call('GET', `/v1/github/repo-access?repo=${encodeURIComponent(REPO)}`)
    const setupPage = await browser(`https://sandbox.test/v1/github/setup?installation_id=900&state=${encodeURIComponent(stateOf(missing.body.installUrl))}`)
    const done = await browser(`https://sandbox.test/v1/github/callback?code=code_admin&state=${encodeURIComponent(stateOf(setupPage.location!))}`)
    expect(done.text).toContain('Connected GitHub <b>acme</b>')
    notices.length = 0
    const added = await webhook('installation_repositories', {
      action: 'added',
      installation: { id: 900, account: ACME },
      repository_selection: 'selected',
      repositories_added: [{ full_name: 'acme/api' }],
      repositories_removed: [],
      requester: null,
      sender: { id: 3, type: 'User' }
    })
    expect(added.body.installation).toMatchObject({ handled: 'repositories_added', notified: 1 })
    expect(notices).toEqual([{ accountId: 'user:alice', repo: 'https://github.com/acme/api', state: 'done' }])
    const deleted = await webhook('installation', { action: 'deleted', installation: { id: 900, account: ACME }, sender: { id: 3, type: 'User' } })
    expect(deleted.body.installation).toMatchObject({ handled: 'deleted', revoked: 1 })
    github.installations.length = 0
    expect((await h.call('GET', `/v1/github/repo-access?repo=${encodeURIComponent(REPO)}`)).body.access).toBe('missing')
  })

  it('lists repositories across the account’s bound installations, paginated (N12)', async () => {
    const { h, github, browser } = await setup()
    const many = Array.from({ length: 130 }, (_, n) => `acme/repo-${n}`)
    github.installations.push({ id: 900, account: ACME, repos: ['acme/web', ...many] })
    const missing = await h.call('GET', `/v1/github/repo-access?repo=${encodeURIComponent(REPO)}`)
    const setupPage = await browser(`https://sandbox.test/v1/github/setup?installation_id=900&state=${encodeURIComponent(stateOf(missing.body.installUrl))}`)
    await browser(`https://sandbox.test/v1/github/callback?code=code_admin&state=${encodeURIComponent(stateOf(setupPage.location!))}`)
    const first = await h.call('GET', '/v1/github/repositories')
    expect(first.body.repositories).toHaveLength(100)
    expect(first.body.repositories[0]).toEqual({
      id: 1000,
      fullName: 'acme/web',
      url: REPO,
      owner: 'acme',
      private: true,
      defaultBranch: 'main',
      pushedAt: null,
      installationId: 900
    })
    expect(first.body.nextCursor).toBe('0.2')
    expect(HostedGithubRepositoriesResponseSchema.parse(first.body)).toEqual(first.body)
    const second = await h.call('GET', `/v1/github/repositories?cursor=${first.body.nextCursor}`)
    expect(second.body.repositories).toHaveLength(31)
    expect(second.body.nextCursor).toBeNull()
    expect((await h.call('GET', '/v1/github/repositories', { as: 'bob' })).body).toEqual({ repositories: [], nextCursor: null })
  })

  it('billing’s setup chain gets an install URL carrying its session, behind CONTROL_PLANE_TOKEN', async () => {
    const { h, github } = await setup()
    const path = `/v1/internal/github/install-url?accountId=org:acme-team&userId=u1&repo=${encodeURIComponent(REPO)}&session=${SESSION}`
    expect((await h.call('GET', path, { bearer: 'nope'.repeat(10) })).status).toBe(404)
    const answer = await h.call('GET', path, { bearer: CONTROL_PLANE_TOKEN })
    expect(answer.body.access).toBe('missing')
    expect(answer.body.url).toMatch(/^https:\/\/github\.com\/apps\/orca-cloud-test\/installations\/new\?state=/)
    github.installations.push({ id: 900, account: ACME, repos: ['acme/web'] })
    h.raw
      .prepare(
        `INSERT INTO github_installations VALUES (900, 'org:acme-team', 50, 'acme', 'Organization', 'u1', 3, 'oauth', 0, NULL)`
      )
      .run()
    expect((await h.call('GET', path, { bearer: CONTROL_PLANE_TOKEN })).body).toEqual({ access: 'granted', url: null })
    expect((await h.call('GET', path.replace(SESSION, 'bad'), { bearer: CONTROL_PLANE_TOKEN })).status).toBe(400)
  })

  it('N5: binds with the GitHub identity from the Orca sign-in, skipping GitHub’s Authorize page', async () => {
    const { h, github, browser } = await setup()
    const base = `/v1/internal/github/install-url?accountId=org:acme-team&userId=u1&repo=${encodeURIComponent(REPO)}&session=${SESSION}`
    github.installations.push({ id: 900, account: ACME, repos: ['acme/web'] })
    github.installations.length = 0
    // A member (not an org admin) falls back to OAuth.
    const memberUrl = (await h.call('GET', `${base}&githubUserId=2&githubLogin=sam-gh`, { bearer: CONTROL_PLANE_TOKEN })).body.url
    github.installations.push({ id: 900, account: ACME, repos: ['acme/web'] })
    const fallback = await browser(`https://sandbox.test/v1/github/setup?installation_id=900&setup_action=install&state=${encodeURIComponent(stateOf(memberUrl))}`)
    expect(fallback.location).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize/)
    expect(await isInstallationBound(h.env.SANDBOX_DB, 900, 'org:acme-team')).toBe(false)

    // The org admin is bound straight away and sent back to the setup session.
    github.installations.length = 0
    const adminUrl = (await h.call('GET', `${base}&githubUserId=3&githubLogin=admin-gh`, { bearer: CONTROL_PLANE_TOKEN })).body.url
    github.installations.push({ id: 900, account: ACME, repos: ['acme/web'] })
    const bound = await browser(`https://sandbox.test/v1/github/setup?installation_id=900&setup_action=install&state=${encodeURIComponent(stateOf(adminUrl))}`)
    expect(bound.location).toBe(`https://auth.test/cloud/setup/next?session=${SESSION}&from=github`)
    expect(await isInstallationBound(h.env.SANDBOX_DB, 900, 'org:acme-team')).toBe(true)
    const row = h.raw.prepare('SELECT method, bound_by_github_user_id FROM github_installations WHERE installation_id = 900').get()
    expect(row).toEqual({ method: 'idp', bound_by_github_user_id: 3 })
    // No OAuth code, no user token: the IdP fast path connects no commit identity.
    expect(github.calls.filter((c) => c.includes('/login/oauth/access_token'))).toEqual([])
    expect(h.raw.prepare('SELECT COUNT(*) AS n FROM github_user_tokens').get()).toEqual({ n: 0 })
    // The state is single-use.
    const replay = await browser(`https://sandbox.test/v1/github/setup?installation_id=900&setup_action=install&state=${encodeURIComponent(stateOf(adminUrl))}`)
    expect(replay.text).toContain('already used')
  })
  it('install redirect with an OAuth code (request-auth-on-install) binds via OAuth and stores the identity, even with an N5 identity', async () => {
    const { h, github, browser } = await setup()
    const base = `/v1/internal/github/install-url?accountId=org:acme-team&userId=u1&repo=${encodeURIComponent(REPO)}&session=${SESSION}`
    // The state carries the N5 GitHub identity (`g`), which alone would take the IdP fast path.
    const url = (await h.call('GET', `${base}&githubUserId=3&githubLogin=admin-gh`, { bearer: CONTROL_PLANE_TOKEN })).body.url
    github.installations.push({ id: 900, account: ACME, repos: ['acme/web'] })
    // GitHub's install redirect with OAuth-during-install enabled: code + installation_id + setup_action + our state.
    const bound = await browser(
      `https://sandbox.test/v1/github/setup?code=code_admin&installation_id=900&setup_action=install&state=${encodeURIComponent(stateOf(url))}`
    )
    expect(bound.location).toBe(`https://auth.test/cloud/setup/next?session=${SESSION}&from=github`)
    expect(github.calls.filter((c) => c.includes('/login/oauth/access_token'))).toHaveLength(1)
    // The code path ran, not the IdP path: no App-credential installer check, and the bind is 'oauth'.
    expect(github.calls.filter((c) => c === 'GET /app/installations/900' || c.startsWith('GET /orgs/acme/memberships/'))).toEqual([])
    expect(h.raw.prepare('SELECT account_id, method, bound_by_user_id, bound_by_github_user_id AS gh FROM github_installations').all()).toEqual([
      { account_id: 'org:acme-team', method: 'oauth', bound_by_user_id: 'u1', gh: 3 }
    ])
    expect(h.raw.prepare('SELECT account_id, user_id, github_user_id, github_login FROM github_user_tokens').all()).toEqual([
      { account_id: 'org:acme-team', user_id: 'u1', github_user_id: 3, github_login: 'admin-gh' }
    ])
    const asU1 = await h.call('GET', '/v1/github/user', { bearer: await h.token('u1', 'acme-team') })
    expect(asU1.body).toEqual({ connected: true, login: 'admin-gh', githubUserId: 3 })
  })
})

describe('repo-access canInstall (REPO-CAN-INSTALL)', () => {
  type Ctx = Awaited<ReturnType<typeof setup>>
  const access = (h: Ctx['h'], repo = REPO, as?: string) => h.call('GET', `/v1/github/repo-access?repo=${encodeURIComponent(repo)}`, as ? { as } : {})
  const membershipCalls = (ctx: Ctx) => ctx.github.calls.filter((c) => c.startsWith('GET /user/memberships/orgs/'))
  /** canInstall's reads: owner type and membership. */
  const github = (ctx: Ctx) => ctx.github.calls.filter((c) => c.startsWith('GET /user/memberships/orgs/') || c.startsWith('GET /users/'))

  /** Connects alice (account user:alice, user alice) as the fake GitHub user behind `code`. */
  async function connect(ctx: Ctx, code: string, user: { id: number; login: string }, tokens: { accessExpiresAt?: number | null; refresh?: string | null } = {}) {
    ctx.github.tokens.set(`gho_${code}`, code)
    await storeUserToken(
      ctx.h.env.SANDBOX_DB,
      await keyringFor(ctx.h.env)!,
      { account_id: 'user:alice', user_id: 'alice' },
      user,
      { access: `gho_${code}`, refresh: tokens.refresh ?? null, accessExpiresAt: tokens.accessExpiresAt ?? null, refreshExpiresAt: null },
      ctx.h.now()
    )
  }

  it('missing without a connected GitHub user: null, and GitHub is not asked', async () => {
    const ctx = await setup()
    const missing = await access(ctx.h)
    expect(missing.body).toMatchObject({ access: 'missing', canInstall: null })
    expect(missing.body.installUrl).toBeDefined()
    expect(HostedGithubRepoAccessResponseSchema.parse(missing.body)).toEqual(missing.body)
    expect(membershipCalls(ctx)).toEqual([])
  })

  it('missing on the person’s own GitHub account (login matched case-insensitively): true', async () => {
    const ctx = await setup()
    await connect(ctx, 'code_alice', { id: 7, login: 'Alice-GH' })
    expect((await access(ctx.h, 'https://github.com/alice-gh/dotfiles')).body).toMatchObject({ access: 'missing', owner: 'alice-gh', canInstall: true })
    expect(membershipCalls(ctx)).toEqual([])
  })

  it('missing on an org: admin true, member false', async () => {
    const ctx = await setup()
    await connect(ctx, 'code_admin', { id: 3, login: 'admin-gh' })
    expect((await access(ctx.h)).body).toMatchObject({ access: 'missing', canInstall: true })
    expect(github(ctx)).toEqual(['GET /users/acme', 'GET /user/memberships/orgs/acme'])

    await connect(ctx, 'code_sam', { id: 2, login: 'sam-gh' })
    expect((await access(ctx.h)).body).toMatchObject({ access: 'missing', canInstall: false })
  })

  it('org membership unreadable (404 or 403: the App isn’t installed there): null, never false', async () => {
    const ctx = await setup()
    await connect(ctx, 'code_sam', { id: 2, login: 'sam-gh' })
    // sam isn't in other-org: GitHub answers 404, which a user token for an uninstalled App also gets.
    expect((await access(ctx.h, 'https://github.com/other-org/app')).body).toMatchObject({ access: 'missing', canInstall: null })
    await connect(ctx, 'code_admin', { id: 3, login: 'admin-gh' })
    ctx.github.faults.membership = 'forbidden'
    expect((await access(ctx.h)).body).toMatchObject({ access: 'missing', canInstall: null })
  })

  it('someone else’s personal account: false, without reading memberships', async () => {
    const ctx = await setup()
    await connect(ctx, 'code_sam', { id: 2, login: 'sam-gh' })
    expect((await access(ctx.h, 'https://github.com/admin-gh/notes')).body).toMatchObject({ access: 'missing', owner: 'admin-gh', canInstall: false })
    expect(github(ctx)).toEqual(['GET /users/admin-gh'])
  })

  it('owner-type lookup failing or timing out: null', async () => {
    const ctx = await setup()
    await connect(ctx, 'code_admin', { id: 3, login: 'admin-gh' })
    ctx.github.faults.users = 'error'
    expect((await access(ctx.h)).body).toMatchObject({ access: 'missing', canInstall: null })
    expect(membershipCalls(ctx)).toEqual([])
    // Unknown owner (404 from /users): null too.
    ctx.github.faults.users = undefined
    expect((await access(ctx.h, 'https://github.com/nobody-here/x')).body).toMatchObject({ access: 'missing', canInstall: null })
    ctx.github.faults.users = 'hang'
    const started = Date.now()
    const timedOut = await access(ctx.h)
    expect(timedOut.status).toBe(200)
    expect(timedOut.body).toMatchObject({ access: 'missing', canInstall: null })
    expect(timedOut.body.installUrl).toBeDefined()
    expect(Date.now() - started).toBeLessThan(6_000)
  }, 10_000)

  it('membership read erroring or timing out: null, and the rest of the answer is unchanged', async () => {
    const ctx = await setup()
    await connect(ctx, 'code_admin', { id: 3, login: 'admin-gh' })
    ctx.github.faults.membership = 'error'
    const errored = await access(ctx.h)
    expect(errored.status).toBe(200)
    expect(errored.body).toMatchObject({ access: 'missing', owner: 'acme', repo: REPO, canInstall: null })
    expect(errored.body.installUrl).toBeDefined()

    ctx.github.faults.membership = 'hang'
    const started = Date.now()
    const timedOut = await access(ctx.h)
    expect(timedOut.status).toBe(200)
    expect(timedOut.body).toMatchObject({ access: 'missing', canInstall: null })
    expect(timedOut.body.installUrl).toBeDefined()
    expect(Date.now() - started).toBeLessThan(6_000)
  }, 10_000)

  it('public: present while the App isn’t on the owner, absent once an installation exists', async () => {
    const ctx = await setup({ publicRepos: ['https://github.com/acme/site'] })
    await connect(ctx, 'code_sam', { id: 2, login: 'sam-gh' })
    expect((await access(ctx.h, 'https://github.com/acme/site')).body).toEqual({
      access: 'public',
      owner: 'acme',
      repo: 'https://github.com/acme/site',
      canInstall: false
    })
    await connect(ctx, 'code_admin', { id: 3, login: 'admin-gh' })
    expect((await access(ctx.h, 'https://github.com/acme/site')).body).toMatchObject({ access: 'public', canInstall: true })
    // Installed on acme (bound to some other Orca account): the App is there, so no canInstall.
    ctx.github.installations.push({ id: 900, account: ACME, repos: ['acme/site'] })
    expect((await access(ctx.h, 'https://github.com/acme/site')).body).toEqual({ access: 'public', owner: 'acme', repo: 'https://github.com/acme/site' })
  })

  it('granted and requested: absent', async () => {
    const ctx = await setup()
    const missing = await access(ctx.h)
    ctx.github.installations.push({ id: 900, account: ACME, repos: ['acme/web'] })
    const setupPage = await ctx.browser(`https://sandbox.test/v1/github/setup?installation_id=900&setup_action=install&state=${encodeURIComponent(stateOf(missing.body.installUrl))}`)
    await ctx.browser(`https://sandbox.test/v1/github/callback?code=code_admin&state=${encodeURIComponent(stateOf(setupPage.location!))}`)
    expect((await access(ctx.h)).body).toEqual({ access: 'granted', owner: 'acme', repo: REPO })

    // Sam (a member, connected by the request's OAuth round trip) asks an owner: requested.
    const other = await setup()
    const samMissing = await access(other.h, REPO, 'sam')
    const page = await other.browser(`https://sandbox.test/v1/github/setup?setup_action=request&state=${encodeURIComponent(stateOf(samMissing.body.installUrl))}`)
    other.github.requests.push({ account: { login: 'acme' }, requester: { id: 2 } })
    await other.browser(`https://sandbox.test/v1/github/callback?code=code_sam&state=${encodeURIComponent(stateOf(page.location!))}`)
    expect((await access(other.h, REPO, 'sam')).body).toEqual({ access: 'requested', owner: 'acme', repo: REPO })
  })

  it('a token near expiry is refreshed through the member-git helper before the membership read', async () => {
    const ctx = await setup()
    await connect(ctx, 'code_admin', { id: 3, login: 'admin-gh' }, { accessExpiresAt: ctx.h.now() + 60_000, refresh: 'ghr_code_admin' })
    expect((await access(ctx.h)).body).toMatchObject({ access: 'missing', canInstall: true })
    expect(ctx.github.calls).toContain('POST /login/oauth/access_token')
    expect(ctx.h.raw.prepare('SELECT access_expires_at AS e FROM github_user_tokens').get()).toEqual({ e: ctx.h.now() + 28_800_000 })
  })

  it('an expired token that can’t be refreshed: null', async () => {
    const ctx = await setup()
    await connect(ctx, 'code_admin', { id: 3, login: 'admin-gh' }, { accessExpiresAt: ctx.h.now() - 1, refresh: null })
    expect((await access(ctx.h)).body).toMatchObject({ access: 'missing', canInstall: null })
    expect(membershipCalls(ctx)).toEqual([])
  })
})
