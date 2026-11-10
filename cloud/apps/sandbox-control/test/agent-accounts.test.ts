import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isSharedWorkspace } from '../src/account-providers'
import { ENV_COMMAND, START_COMMAND } from '../src/sandbox-vm-commands'
import { createHarness } from './harness'

const KEK = Buffer.alloc(32, 7).toString('base64')
const PROXY_URL = 'https://sandbox.test/v1/egress/proxy'
const SETUP_TOKEN = 'sk-ant-oat01-FAKEsetupTOKEN_for_tests_only_000000000000'
const TEAM_KEY = 'sk-ant-api03-TEAM-fake-0000-aaaa'

let logs: string[] = []
beforeEach(() => {
  logs = []
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
    })
  }
})
afterEach(() => {
  for (const value of [SETUP_TOKEN, TEAM_KEY]) {
    expect(logs.join('\n')).not.toContain(value)
  }
  vi.restoreAllMocks()
})

function decode(encoded: string | undefined): Record<string, string> {
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

async function setup(overrides: Record<string, string> = {}) {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'v1', alg: 'RS256' }] }
  const upstream: { url: string; headers: Headers }[] = []
  const reply = { status: 200 }
  const h = await createHarness(
    { SECRETS_KEK: KEK, EGRESS_PROXY_URL: PROXY_URL, SECRETS_EGRESS_PLACEHOLDERS: 'on', AGENT_ACCOUNTS_CLAUDE: 'on', ...overrides },
    {
      egressKeysForIssuer: () => createLocalJWKSet(jwks),
      credentials: { authorizationFor: async () => null },
      egressFetch: async (input, init) => {
        upstream.push({ url: String(input), headers: new Headers(init?.headers) })
        return new Response('{}', { status: reply.status })
      }
    }
  )
  const as = (sub: string, org?: string, role?: string) => h.token(sub, org, 'sandbox', role ? { orgRole: role } : {})
  const lastEnv = (command: string) => decode(h.vercel.commands.filter((c) => c.command === command).at(-1)?.env.ORCA_SECRET_ENV)
  async function proxied(sandboxId: string, host: string, headers: Record<string, string>) {
    const oidc = await new SignJWT({ team_id: 'team_orca', project_id: 'prj_orca', sandbox_name: `orca-test-${sandboxId}` })
      .setProtectedHeader({ alg: 'RS256', kid: 'v1' })
      .setIssuer('https://oidc.vercel.com/team_orca')
      .setAudience(PROXY_URL)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    const response = await h.send(
      new Request(`${PROXY_URL}/v1/messages`, {
        method: 'POST',
        body: '{}',
        headers: {
          'vercel-forwarded-host': host,
          'vercel-forwarded-scheme': 'https',
          'vercel-forwarded-port': '443',
          'vercel-forwarded-path': '/v1/messages',
          'vercel-sandbox-oidc-token': oidc,
          ...headers
        }
      })
    )
    return { status: response.status, body: await response.text() }
  }
  return { h, as, lastEnv, proxied, upstream, reply }
}

describe('Orca-account credentials (D11)', () => {
  it('stores a Claude setup-token Personal-only and never returns or logs it; flag off = no route', async () => {
    const off = await setup({ AGENT_ACCOUNTS_CLAUDE: '' })
    const mia0 = await off.as('mia')
    expect((await off.h.call('PUT', '/v1/agent-credentials/claude', { bearer: mia0, body: { token: SETUP_TOKEN } })).status).toBe(404)

    const { h, as } = await setup()
    const mia = await as('mia')
    expect((await h.call('PUT', '/v1/agent-credentials/claude', { bearer: mia, body: { token: 'sk-ant-api03-not-a-setup-token' } })).body.reason).toBe('invalid_token')
    const put = await h.call('PUT', '/v1/agent-credentials/claude', { bearer: mia, body: { token: SETUP_TOKEN, label: 'mia@example.com' } })
    expect(put.status).toBe(200)
    expect(put.body.claude).toMatchObject({ state: 'active', label: 'mia@example.com' })
    expect(put.body.providerEnabled).toEqual({ claude: true, codex: false })
    expect(JSON.stringify(put.body)).not.toContain(SETUP_TOKEN)
    // Someone else sees nothing of Mia's.
    expect((await h.call('GET', '/v1/agent-credentials', { bearer: await as('bob') })).body.claude.state).toBe('none')
    expect((await h.call('DELETE', '/v1/agent-credentials/claude', { bearer: mia })).body.claude.state).toBe('none')
  })
})

describe('egress-time Source (D10) and shared workspaces (D13)', () => {
  it('a set-up account is the implicit Source with no key: placeholder in the VM, real token only at egress', async () => {
    const { h, as, lastEnv, proxied, upstream } = await setup()
    const mia = await as('mia')
    await h.call('PUT', '/v1/agent-credentials/claude', { bearer: mia, body: { token: SETUP_TOKEN } })
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    const id: string = created.body.sandbox.id
    const env = lastEnv(START_COMMAND)
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(`orca-ph-claude-account-${id}`)
    expect(JSON.stringify(env)).not.toContain(SETUP_TOKEN)
    const box = [...h.vercel.boxes.values()][0]!
    expect(box.policy.allow['api.anthropic.com']!.at(-1)).toEqual({ response: { statusCode: 403, body: 'orca-egress-denied', contentType: 'text/plain' } })
    expect((await proxied(id, 'api.anthropic.com', { authorization: `Bearer orca-ph-claude-account-${id}` })).status).toBe(200)
    expect(upstream.at(-1)!.headers.get('authorization')).toBe(`Bearer ${SETUP_TOKEN}`)
    const view = await h.call('GET', `/v1/agent-sources?workspaceId=${id}`, { bearer: mia })
    expect(view.body.effective.claude).toEqual({ source: 'sign-in', origin: 'implicit' })
    expect(view.body.sharedWorkspace).toBe(false)
  })

  it('a team key wins by default; choosing "Your account" swaps the key out live; deleting the account falls back', async () => {
    const { h, as, lastEnv, proxied, upstream } = await setup()
    const ada = await as('ada', 'acme', 'admin')
    const mia = await as('mia', 'acme', 'member')
    await h.call('PUT', '/v1/secrets/org/ANTHROPIC_API_KEY', { bearer: ada, body: { value: TEAM_KEY } })
    await h.call('PUT', '/v1/agent-credentials/claude', { bearer: mia, body: { token: SETUP_TOKEN } })
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    const id: string = created.body.sandbox.id
    expect(lastEnv(START_COMMAND).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(lastEnv(START_COMMAND).ANTHROPIC_API_KEY).toMatch(/^orca-ph-anthropic-api-key-/)
    await h.call('PUT', '/v1/agent-sources', { bearer: mia, body: { agent: 'claude', source: 'sign-in' } })
    let env = lastEnv(ENV_COMMAND)
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(`orca-ph-claude-account-${id}`)
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect((await proxied(id, 'api.anthropic.com', { authorization: `Bearer orca-ph-claude-account-${id}` })).status).toBe(200)
    expect(upstream.at(-1)!.headers.get('authorization')).toBe(`Bearer ${SETUP_TOKEN}`)
    await h.call('DELETE', '/v1/agent-credentials/claude', { bearer: mia })
    // The proxy refuses at once; the session moves back to the team key.
    expect((await proxied(id, 'api.anthropic.com', { authorization: `Bearer orca-ph-claude-account-${id}` })).status).toBe(403)
    env = lastEnv(ENV_COMMAND)
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toMatch(/^orca-ph-anthropic-api-key-/)
  })

  it('never uses a personal account in a workspace shared with teammates', async () => {
    const { h, as, lastEnv, proxied } = await setup()
    const mia = await as('mia', 'acme', 'member')
    await h.call('PUT', '/v1/agent-credentials/claude', { bearer: mia, body: { token: SETUP_TOKEN } })
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    const id: string = created.body.sandbox.id
    expect(lastEnv(START_COMMAND).CLAUDE_CODE_OAUTH_TOKEN).toBe(`orca-ph-claude-account-${id}`)
    // The workspace becomes shared: the very next request is refused, and the session refreshes off the account.
    await h.env.SANDBOX_DB.prepare(`UPDATE sandboxes SET visibility = 'team' WHERE id = ?`).bind(id).run()
    const refused = await proxied(id, 'api.anthropic.com', { authorization: `Bearer orca-ph-claude-account-${id}` })
    expect(refused.status).toBe(403)
    expect(lastEnv(ENV_COMMAND).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect((await h.call('GET', `/v1/agent-sources?workspaceId=${id}`, { bearer: mia })).body.sharedWorkspace).toBe(true)
  })

  it('a workspace handed to a new owner never uses the new owner\'s account behind the old session', async () => {
    const { h, as, proxied } = await setup()
    const mia = await as('mia', 'acme', 'member')
    const bob = await as('bob', 'acme', 'member')
    await h.call('PUT', '/v1/agent-credentials/claude', { bearer: mia, body: { token: SETUP_TOKEN } })
    await h.call('PUT', '/v1/agent-credentials/claude', { bearer: bob, body: { token: 'sk-ant-oat01-BOBsetupTOKEN_for_tests_only_111111111111' } })
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    const id: string = created.body.sandbox.id
    await h.env.SANDBOX_DB.prepare(`UPDATE sandboxes SET user_id = 'bob' WHERE id = ?`).bind(id).run()
    const refused = await proxied(id, 'api.anthropic.com', { authorization: `Bearer orca-ph-claude-account-${id}` })
    expect(refused).toEqual({ status: 403, body: 'account_owner_changed' })
  })

  it('a 401 from the provider marks the account revoked and the session falls off it', async () => {
    const { h, as, proxied, reply, lastEnv } = await setup()
    const mia = await as('mia')
    await h.call('PUT', '/v1/agent-credentials/claude', { bearer: mia, body: { token: SETUP_TOKEN } })
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    const id: string = created.body.sandbox.id
    reply.status = 401
    expect((await proxied(id, 'api.anthropic.com', { authorization: `Bearer orca-ph-claude-account-${id}` })).status).toBe(401)
    expect((await h.call('GET', '/v1/agent-credentials', { bearer: mia })).body.claude.state).toBe('revoked')
    // Already off the account: no placeholder in new shells, and the proxy refuses with a clear reason.
    await vi.waitFor(() => expect(lastEnv(ENV_COMMAND).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined())
    expect((await proxied(id, 'api.anthropic.com', { authorization: `Bearer orca-ph-claude-account-${id}` })).status).toBe(403)
  })

  it('kill switch: Source "sign-in" falls back to the agent signing in inside the sandbox (no key, no placeholder)', async () => {
    const { h, as, lastEnv } = await setup({ AGENT_ACCOUNTS_CLAUDE_DISABLED: '1' })
    const ada = await as('ada', 'acme', 'admin')
    const mia = await as('mia', 'acme', 'member')
    await h.call('PUT', '/v1/secrets/org/ANTHROPIC_API_KEY', { bearer: ada, body: { value: TEAM_KEY } })
    await h.call('PUT', '/v1/agent-sources', { bearer: mia, body: { agent: 'claude', source: 'sign-in' } })
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    const env = lastEnv(START_COMMAND)
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect((await h.call('GET', '/v1/agent-credentials', { bearer: mia })).body.providerEnabled.claude).toBe(false)
  })
})

describe('D13 fails closed', () => {
  it('treats any visibility other than private as shared', () => {
    expect(isSharedWorkspace({ visibility: 'private' })).toBe(false)
    expect(isSharedWorkspace({ visibility: 'team' })).toBe(true)
    for (const visibility of ['', 'org', null, undefined] as unknown as string[]) {
      expect(isSharedWorkspace({ visibility } as never)).toBe(true)
    }
  })
})
