// SEC-5: a workspace shared with teammates runs their shells too, so nothing personal to its owner may
// be in its env: not a variable's value, and not a placeholder that would spend the owner's model key.
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ENV_COMMAND, START_COMMAND } from '../src/sandbox-vm-commands'
import { ownersForSandbox } from '../src/secrets'
import { createHarness } from './harness'

const KEK = Buffer.alloc(32, 7).toString('base64')
const PROXY_URL = 'https://sandbox.test/v1/egress/proxy'
// Fake values only.
const TEAM_KEY = 'sk-ant-api03-TEAM-fake-0000-aaaa'
const PERSONAL_OPENAI = 'sk-proj-fake-personal-openai-2222'
const PERSONAL_VALUES = [PERSONAL_OPENAI, 'personal-db-password', 'personal-foo-value', 'personal-aws-secret-value']

type Harness = Awaited<ReturnType<typeof createHarness>>

const logs: string[] = []
beforeEach(() => {
  logs.length = 0
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
    })
  }
})
afterEach(() => {
  for (const value of [...PERSONAL_VALUES, TEAM_KEY]) {
    expect(logs.join('\n')).not.toContain(value)
  }
  vi.restoreAllMocks()
})

function decodeEnv(encoded: string | undefined): Record<string, string> {
  return Object.fromEntries(
    (encoded ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf('=')
        return [line.slice(0, at), Buffer.from(line.slice(at + 1), 'base64').toString('utf8')]
      })
  )
}

/** The env the VM got at its last boot, or from its last live refresh. */
function vmEnv(h: Harness, command: string = START_COMMAND): Record<string, string> {
  return decodeEnv(h.vercel.commands.filter((c) => c.command === command).at(-1)!.env.ORCA_SECRET_ENV)
}

/** Everything the control plane ever sent the VM, as one string: no personal value may be in it. */
function everythingSent(h: Harness, from = 0): string {
  return JSON.stringify(
    h.vercel.commands.slice(from).map((c) => ({ ...c, env: { ...c.env, ORCA_SECRET_ENV: decodeEnv(c.env.ORCA_SECRET_ENV) } }))
  )
}

async function seeded(overrides: Record<string, string> = {}, deps: Parameters<typeof createHarness>[1] = {}) {
  const h = await createHarness({ SECRETS_KEK: KEK, ...overrides }, deps)
  const admin = await h.token('ada', 'acme', 'sandbox', { orgRole: 'admin' })
  const mia = await h.token('mia', 'acme', 'sandbox', { orgRole: 'member' })
  const put = (scope: string, name: string, value: string, bearer: string, repo?: string) =>
    h.call('PUT', `/v1/secrets/${scope}/${name}${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`, { body: { value }, bearer })
  await put('org', 'ANTHROPIC_API_KEY', TEAM_KEY, admin)
  await put('org', 'FOO', 'team-foo-value', admin)
  await put('repo', 'BAR', 'repo-bar-value', admin, 'acme/app')
  await put('personal', 'OPENAI_API_KEY', PERSONAL_OPENAI, mia)
  await put('personal', 'DB_PASSWORD', 'personal-db-password', mia)
  await put('personal', 'FOO', 'personal-foo-value', mia)
  await put('personal', 'AWS_SECRET_ACCESS_KEY', 'personal-aws-secret-value', mia)
  const create = (visibility?: 'team' | 'private') =>
    h.call('POST', '/v1/sandboxes', {
      body: { workspaceId: 'ws-1', machineSize: 'standard', repo: { url: 'https://github.com/acme/app' }, ...(visibility ? { visibility } : {}) },
      bearer: mia
    })
  const share = (id: string, visibility: 'team' | 'private') =>
    h.call('PATCH', `/v1/team/workspaces/${id}`, { body: { visibility }, bearer: mia })
  return { h, mia, admin, put, create, share }
}

const TEAM_AND_REPO = { ANTHROPIC_API_KEY: TEAM_KEY, BAR: 'repo-bar-value', FOO: 'team-foo-value' }

describe('personal secrets in shared workspaces (SEC-5)', () => {
  it('resolves no personal owner for a shared row, and fails closed on an unknown visibility', () => {
    const row = { account_id: 'org:acme', user_id: 'mia', repo_url: 'https://github.com/acme/app' }
    expect(ownersForSandbox({ ...row, visibility: 'private' }).personal).toBe('user:mia')
    expect(ownersForSandbox({ ...row, visibility: 'team' })).toEqual({ org: 'org:acme', personal: null, repo: 'org:acme#github.com/acme/app' })
    expect(ownersForSandbox({ ...row, visibility: undefined as never }).personal).toBeNull()
  })

  it('keeps the owner’s personal secrets in their own private workspace', async () => {
    const { h, create } = await seeded()
    expect((await create()).status).toBe(200)
    expect(vmEnv(h)).toEqual({
      ...TEAM_AND_REPO,
      AWS_SECRET_ACCESS_KEY: 'personal-aws-secret-value',
      DB_PASSWORD: 'personal-db-password',
      FOO: 'personal-foo-value',
      OPENAI_API_KEY: PERSONAL_OPENAI
    })
  })

  it('starts a shared workspace with team and repository secrets only; the team value replaces a personal override', async () => {
    const { h, create } = await seeded()
    expect((await create('team')).status).toBe(200)
    expect(vmEnv(h)).toEqual(TEAM_AND_REPO)
    for (const value of PERSONAL_VALUES) {
      expect(everythingSent(h)).not.toContain(value)
    }
  })

  it('drops them from a running workspace the moment it is shared, and brings them back when it is private again', async () => {
    const { h, create, share, mia } = await seeded()
    const id: string = (await create()).body.sandbox.id
    expect(vmEnv(h).DB_PASSWORD).toBe('personal-db-password')
    const before = h.vercel.commands.length

    expect((await share(id, 'team')).status).toBe(200)
    expect(vmEnv(h, ENV_COMMAND)).toEqual(TEAM_AND_REPO)
    for (const value of PERSONAL_VALUES) {
      expect(everythingSent(h, before)).not.toContain(value)
    }
    // A wake while shared resolves the same way.
    await h.call('POST', `/v1/sandboxes/${id}/suspend`, { bearer: mia })
    await h.call('POST', `/v1/sandboxes/${id}/resume`, { bearer: mia })
    expect(vmEnv(h)).toEqual(TEAM_AND_REPO)

    expect((await share(id, 'private')).status).toBe(200)
    expect(vmEnv(h, ENV_COMMAND)).toMatchObject({ DB_PASSWORD: 'personal-db-password', FOO: 'personal-foo-value' })
  })

  it('does not pick up a personal secret the owner saves while the workspace is shared', async () => {
    const { h, create, put, mia } = await seeded()
    await create('team')
    await put('personal', 'LATER', 'personal-db-password', mia)
    const refreshes = h.vercel.commands.filter((c) => c.command === ENV_COMMAND)
    for (const refresh of refreshes) {
      expect(decodeEnv(refresh.env.ORCA_SECRET_ENV)).toEqual(TEAM_AND_REPO)
    }
  })
})

describe('personal model keys in shared workspaces with egress placeholders (SEC-5)', () => {
  async function placeholderSetup() {
    const { privateKey, publicKey } = await generateKeyPair('RS256')
    const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'v1', alg: 'RS256' }] }
    const upstream: { url: string; headers: Headers }[] = []
    const ctx = await seeded(
      { SECRETS_EGRESS_PLACEHOLDERS: 'on', EGRESS_PROXY_URL: PROXY_URL },
      {
        egressKeysForIssuer: () => createLocalJWKSet(jwks),
        credentials: { authorizationFor: async () => 'Bearer ghs_fake' },
        egressFetch: async (input, init) => {
          upstream.push({ url: String(input), headers: new Headers(init?.headers) })
          return new Response('ok', { status: 200 })
        }
      }
    )
    async function proxied(sandboxId: string, host: string, headers: Record<string, string>) {
      const token = await new SignJWT({ team_id: 'team_orca', project_id: 'prj_orca', sandbox_name: `orca-test-${sandboxId}` })
        .setProtectedHeader({ alg: 'RS256', kid: 'v1' })
        .setIssuer('https://oidc.vercel.com/team_orca')
        .setAudience(PROXY_URL)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey)
      const response = await ctx.h.send(
        new Request(`${PROXY_URL}/v1/messages`, {
          method: 'POST',
          body: '{"model":"x"}',
          headers: {
            'vercel-forwarded-host': host,
            'vercel-forwarded-scheme': 'https',
            'vercel-forwarded-port': '443',
            'vercel-forwarded-path': '/v1/messages',
            'vercel-sandbox-oidc-token': token,
            ...headers
          }
        })
      )
      return response.status
    }
    return { ...ctx, proxied, upstream }
  }

  it('gives a shared workspace no placeholder and no route for the owner’s personal key; the team key still works', async () => {
    const { h, create, proxied, upstream } = await placeholderSetup()
    const id: string = (await create('team')).body.sandbox.id
    const env = vmEnv(h)
    expect(env.ANTHROPIC_API_KEY).toBe(`orca-ph-anthropic-api-key-${id}`)
    expect(env).not.toHaveProperty('OPENAI_API_KEY')
    expect(env).not.toHaveProperty('DB_PASSWORD')
    const [box] = [...h.vercel.boxes.values()]
    // No forward rule for the personal key: nothing is swapped there (no entry under open egress).
    expect(box!.policy.allow['api.openai.com'] ?? []).toEqual([])
    expect(await proxied(id, 'api.openai.com', { authorization: `Bearer orca-ph-openai-api-key-${id}` })).toBe(403)
    expect(await proxied(id, 'api.anthropic.com', { 'x-api-key': `orca-ph-anthropic-api-key-${id}` })).toBe(200)
    expect(upstream).toHaveLength(1)
    expect(upstream[0]!.headers.get('x-api-key')).toBe(TEAM_KEY)
  })

  it('stops swapping the owner’s personal key at the proxy as soon as a running workspace is shared', async () => {
    const { h, create, share, proxied, upstream } = await placeholderSetup()
    const id: string = (await create()).body.sandbox.id
    const placeholder = `orca-ph-openai-api-key-${id}`
    expect(vmEnv(h).OPENAI_API_KEY).toBe(placeholder)
    expect(await proxied(id, 'api.openai.com', { authorization: `Bearer ${placeholder}` })).toBe(200)
    expect(upstream.at(-1)!.headers.get('authorization')).toBe(`Bearer ${PERSONAL_OPENAI}`)

    expect((await share(id, 'team')).status).toBe(200)
    expect(vmEnv(h, ENV_COMMAND)).not.toHaveProperty('OPENAI_API_KEY')
    // A process still holding the old placeholder gets nothing for it.
    expect(await proxied(id, 'api.openai.com', { authorization: `Bearer ${placeholder}` })).toBe(403)
    expect(upstream).toHaveLength(1)
  })
})
