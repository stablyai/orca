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

/** A request still carrying the account placeholder after the account stopped applying gets Anthropic's own
 * auth-failure shape (Claude Code then shows its sign-in message), never a proxy error, and nothing upstream. */
function expectSignedOut(answer: { status: number; body: string }): void {
  expect(answer.status).toBe(401)
  expect(JSON.parse(answer.body)).toMatchObject({ type: 'error', error: { type: 'authentication_error' } })
  expect(JSON.parse(answer.body).error.message).toBe('Your Claude sign-in for Orca Cloud expired. Renew it in Orca: Settings → Cloud agent sign-ins.')
}

async function setup(overrides: Record<string, string> = {}) {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'v1', alg: 'RS256' }] }
  const upstream: { url: string; headers: Headers }[] = []
  const reply = { status: 200 }
  // The control plane's own auth check (count_tokens) before a 401 may revoke; default: the token is dead.
  const check = { status: 401, body: JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }), calls: 0 }
  const h = await createHarness(
    { SECRETS_KEK: KEK, EGRESS_PROXY_URL: PROXY_URL, SECRETS_EGRESS_PLACEHOLDERS: 'on', AGENT_ACCOUNTS_CLAUDE: 'on', ...overrides },
    {
      egressKeysForIssuer: () => createLocalJWKSet(jwks),
      credentials: { authorizationFor: async () => null },
      egressFetch: async (input, init) => {
        if (String(input) === 'https://api.anthropic.com/v1/messages/count_tokens') {
          check.calls++
          expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${SETUP_TOKEN}`)
          return new Response(check.body, { status: check.status })
        }
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
  return { h, as, lastEnv, proxied, upstream, reply, check }
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
    // RS-5: never the email a client sends (it may be another account's): always "Claude subscription".
    expect(put.body.claude).toMatchObject({ state: 'active', label: 'Claude subscription' })
    expect(put.body.providerEnabled).toEqual({ claude: true, codex: false })
    // Codex's flag was never turned on: `off`, which clients word differently from the kill switch.
    expect(put.body.providerState).toEqual({ claude: 'on', codex: 'off' })
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
    expectSignedOut(await proxied(id, 'api.anthropic.com', { authorization: `Bearer orca-ph-claude-account-${id}` }))
    env = lastEnv(ENV_COMMAND)
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toMatch(/^orca-ph-anthropic-api-key-/)
  })

  it('never uses a personal account in a workspace in shared mode (ever transferred)', async () => {
    const { h, as, lastEnv, proxied } = await setup()
    const mia = await as('mia', 'acme', 'member')
    await h.call('PUT', '/v1/agent-credentials/claude', { bearer: mia, body: { token: SETUP_TOKEN } })
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    const id: string = created.body.sandbox.id
    expect(lastEnv(START_COMMAND).CLAUDE_CODE_OAUTH_TOKEN).toBe(`orca-ph-claude-account-${id}`)
    // The workspace goes into shared mode: the very next request is refused, and the session refreshes off the account.
    await h.env.SANDBOX_DB.prepare(`UPDATE sandboxes SET ownership_transferred_at = 1 WHERE id = ?`).bind(id).run()
    const refused = await proxied(id, 'api.anthropic.com', { authorization: `Bearer orca-ph-claude-account-${id}` })
    expectSignedOut(refused)
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
    expectSignedOut(refused)
  })

  it('a 401 confirmed by a later real 401 revokes the account and the session falls off it', async () => {
    const { h, as, proxied, reply, lastEnv } = await setup()
    const mia = await as('mia')
    await h.call('PUT', '/v1/agent-credentials/claude', { bearer: mia, body: { token: SETUP_TOKEN } })
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    const id: string = created.body.sandbox.id
    const other = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-2', machineSize: 'standard' }, bearer: mia })
    const otherSession: string = other.body.sandbox.session.id
    reply.status = 401
    expect((await proxied(id, 'api.anthropic.com', { authorization: `Bearer orca-ph-claude-account-${id}` })).status).toBe(401)
    // RS-2: the auth check (dead token) only puts it in question; a later real request's 401 revokes it.
    await vi.waitFor(async () =>
      expect((await h.call('GET', '/v1/agent-credentials', { bearer: mia })).body.claude).toMatchObject({ state: 'expired', needsCheck: true })
    )
    expect((await proxied(id, 'api.anthropic.com', { authorization: `Bearer orca-ph-claude-account-${id}` })).status).toBe(401)
    await vi.waitFor(async () => expect((await h.call('GET', '/v1/agent-credentials', { bearer: mia })).body.claude.state).toBe('revoked'))
    // Already off the account: no placeholder in new shells, and the proxy refuses with a clear reason.
    await vi.waitFor(() => expect(lastEnv(ENV_COMMAND).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined())
    // The person's other running workspace drops the dead placeholder too.
    await vi.waitFor(() => {
      const refreshed = h.vercel.commands.filter((c) => c.command === ENV_COMMAND && c.sessionId === otherSession)
      expect(refreshed.length).toBeGreaterThan(0)
      expect(decode(refreshed.at(-1)!.env.ORCA_SECRET_ENV).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    })
    expectSignedOut(await proxied(id, 'api.anthropic.com', { authorization: `Bearer orca-ph-claude-account-${id}` }))
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
    const view = (await h.call('GET', '/v1/agent-credentials', { bearer: mia })).body
    expect(view.providerEnabled.claude).toBe(false)
    expect(view.providerState.claude).toBe('disabled')
  })
})

describe('D13: shared mode is a transferred workspace, nothing else', () => {
  it('ignores visibility; only a transfer mark counts', () => {
    expect(isSharedWorkspace({ ownership_transferred_at: null })).toBe(false)
    expect(isSharedWorkspace({ visibility: 'team', ownership_transferred_at: null } as never)).toBe(false)
    expect(isSharedWorkspace({ ownership_transferred_at: 1 })).toBe(true)
  })
})
