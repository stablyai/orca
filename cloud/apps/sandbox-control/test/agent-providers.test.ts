import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { baseUrlHost, credentialTargets, deriveProviderEnv, providerHosts } from '../src/provider-env'
import { egressSecretHosts } from '../src/secret-egress'
import { ENV_COMMAND, START_COMMAND } from '../src/sandbox-vm-commands'
import { createHarness } from './harness'

const KEK = Buffer.alloc(32, 7).toString('base64')
const PROXY_URL = 'https://sandbox.test/v1/egress/proxy'
const GATEWAY_KEY = 'vck_fake-gateway-key-0000-aaaa-bbbb'
const ORG_KEY = 'sk-ant-api03-ORGSHARED-fake-0000-aaaa'
const PERSONAL_KEY = 'sk-ant-api03-PERSONAL-fake-1111-bbbb'
const CUSTOM_TOKEN = 'custom-provider-token-2222-cccc'
const ALL_VALUES = [GATEWAY_KEY, ORG_KEY, PERSONAL_KEY, CUSTOM_TOKEN, 'repo-value-xyz']

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
  for (const value of ALL_VALUES) {
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

async function setup(overrides: Record<string, string> = {}, deps: Parameters<typeof createHarness>[1] = {}) {
  const h = await createHarness({ SECRETS_KEK: KEK, ...overrides }, deps)
  const as = (sub: string, org?: string, role?: string) => h.token(sub, org, 'sandbox', role ? { orgRole: role } : {})
  const put = (scope: string, name: string, value: string, bearer: string, repo?: string) =>
    h.call('PUT', `/v1/secrets/${scope}/${name}${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`, { body: { value }, bearer })
  const commandEnv = (command: string, index = -1) => decode(h.vercel.commands.filter((c) => c.command === command).at(index)?.env.ORCA_SECRET_ENV)
  return { h, as, put, commandEnv }
}

describe('provider presets', () => {
  it('an AI Gateway key alone points Claude Code and Codex at the gateway', () => {
    expect(deriveProviderEnv({ AI_GATEWAY_API_KEY: GATEWAY_KEY })).toEqual({
      AI_GATEWAY_API_KEY: GATEWAY_KEY,
      ANTHROPIC_BASE_URL: 'https://ai-gateway.vercel.sh',
      ANTHROPIC_AUTH_TOKEN: GATEWAY_KEY,
      OPENAI_BASE_URL: 'https://ai-gateway.vercel.sh/v1',
      OPENAI_API_KEY: GATEWAY_KEY
    })
  })

  it('never overrides a provider the user configured', () => {
    const env = deriveProviderEnv({ AI_GATEWAY_API_KEY: GATEWAY_KEY, ANTHROPIC_API_KEY: PERSONAL_KEY })
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBe(GATEWAY_KEY)
  })

  it('accepts only public https base URLs', () => {
    expect(baseUrlHost('https://ai-gateway.vercel.sh')).toBe('ai-gateway.vercel.sh')
    expect(baseUrlHost('https://llm.example.com/anthropic')).toBe('llm.example.com')
    for (const bad of ['http://llm.example.com', 'https://10.0.0.1', 'https://localhost', 'https://box.internal', 'https://u:p@x.example.com', 'https://x.example.com:8443', 'not a url']) {
      expect(baseUrlHost(bad)).toBeNull()
    }
  })

  it('routes each credential to the host its base URL names', () => {
    const targets = credentialTargets(deriveProviderEnv({ AI_GATEWAY_API_KEY: GATEWAY_KEY }))
    expect(targets.map((t) => `${t.secret}@${t.host}`)).toEqual([
      'ANTHROPIC_AUTH_TOKEN@ai-gateway.vercel.sh',
      'AI_GATEWAY_API_KEY@ai-gateway.vercel.sh',
      'OPENAI_API_KEY@ai-gateway.vercel.sh'
    ])
    expect(credentialTargets({ ANTHROPIC_API_KEY: 'k' }).map((t) => t.host)).toEqual(['api.anthropic.com'])
    // A base URL that is not acceptable routes nowhere (and is refused at write time).
    expect(credentialTargets({ ANTHROPIC_BASE_URL: 'http://evil', ANTHROPIC_API_KEY: 'k' })).toEqual([])
    expect(providerHosts({ ANTHROPIC_BASE_URL: 'https://llm.example.com/v1', OPENAI_BASE_URL: 'https://ai-gateway.vercel.sh/v1' })).toEqual([
      'ai-gateway.vercel.sh',
      'llm.example.com'
    ])
  })

  it('reads legacy bare-host rows as the default provider key', () => {
    expect(egressSecretHosts({ egress_secret_hosts: 'api.anthropic.com,api.openai.com' }).map((t) => t.secret)).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'])
  })
})

describe('secret store routes for the desktop UI', () => {
  it('refuses a private or plain-http base URL', async () => {
    const { as, put } = await setup()
    const mia = await as('mia')
    const res = await put('personal', 'ANTHROPIC_BASE_URL', 'http://192.168.1.10:8080', mia)
    expect(res.status).toBe(400)
    expect(res.body.reason).toBe('invalid_base_url')
    expect((await put('personal', 'ANTHROPIC_BASE_URL', 'https://llm.example.com', mia)).status).toBe(200)
  })

  it('effective view: winner per name, what it shadows, and what the caller may write', async () => {
    const { h, as, put } = await setup()
    const ada = await as('ada', 'acme', 'admin')
    const mia = await as('mia', 'acme', 'member')
    await put('org', 'ANTHROPIC_API_KEY', ORG_KEY, ada)
    await put('personal', 'ANTHROPIC_API_KEY', PERSONAL_KEY, mia)
    await put('org', 'SHARED_FLAG', 'org', ada)
    await put('personal', 'SHARED_FLAG', 'mine', mia)
    await put('repo', 'SHARED_FLAG', 'repo-value-xyz', ada, 'acme/app')
    const res = await h.call('GET', '/v1/secrets/effective?repo=acme/app', { bearer: mia })
    expect(res.status).toBe(200)
    expect(res.body.caller).toEqual({ userId: 'mia', orgId: 'acme', orgRole: 'member', canWrite: { personal: true, org: false, repo: false } })
    expect(res.body.precedence.agent_key[0]).toBe('org')
    const byName = Object.fromEntries(res.body.secrets.map((s: { name: string }) => [s.name, s]))
    expect(byName.ANTHROPIC_API_KEY).toMatchObject({ kind: 'agent_key', scope: 'org', hint: 'aaaa', shadowed: [{ scope: 'personal', hint: 'bbbb' }] })
    expect(byName.SHARED_FLAG).toMatchObject({ kind: 'env', scope: 'repo', shadowed: [{ scope: 'personal' }, { scope: 'org' }] })
    expect(JSON.stringify(res.body)).not.toContain(ORG_KEY)
  })

  it('batch writes a pasted .env with per-name errors and partial success', async () => {
    const { h, as } = await setup()
    const mia = await as('mia')
    const res = await h.call('POST', '/v1/secrets/personal/batch', {
      bearer: mia,
      body: { set: { DATABASE_URL: 'postgres://x', PATH: '/evil', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x', 'bad-name': 'v' } }
    })
    expect(res.status).toBe(200)
    expect(res.body.secrets.map((s: { name: string }) => s.name)).toEqual(['DATABASE_URL'])
    expect(res.body.errors).toEqual([
      { name: 'PATH', error: 'invalid_request', reason: 'reserved_name' },
      { name: 'CLAUDE_CODE_OAUTH_TOKEN', error: 'invalid_request', reason: 'subscription_token_refused' },
      { name: 'bad-name', error: 'invalid_request', reason: 'invalid_name' }
    ])
    const removed = await h.call('POST', '/v1/secrets/personal/batch', { bearer: mia, body: { delete: ['DATABASE_URL', 'MISSING'] } })
    expect(removed.body).toEqual({ secrets: [], deleted: ['DATABASE_URL'], errors: [] })
    const member = await h.call('POST', '/v1/secrets/org/batch', { bearer: await as('mia', 'acme', 'member'), body: { set: { A: 'b' } } })
    expect(member.status).toBe(403)
  })
})

describe('session env: presets, managed hosts, live refresh', () => {
  it('a gateway key reaches the VM as a ready provider config and opens the gateway host', async () => {
    const { h, as, put, commandEnv } = await setup()
    const mia = await as('mia')
    await put('personal', 'AI_GATEWAY_API_KEY', GATEWAY_KEY, mia)
    await put('personal', 'ANTHROPIC_MODEL', 'moonshotai/kimi-k2', mia)
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    expect(commandEnv(START_COMMAND)).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://ai-gateway.vercel.sh',
      ANTHROPIC_AUTH_TOKEN: GATEWAY_KEY,
      ANTHROPIC_MODEL: 'moonshotai/kimi-k2',
      OPENAI_BASE_URL: 'https://ai-gateway.vercel.sh/v1'
    })
    expect([...h.vercel.boxes.values()][0]!.policy.allow['ai-gateway.vercel.sh']).toEqual([])
  })

  it('a custom provider host is allowlisted for that session only', async () => {
    const { h, as, put } = await setup()
    const mia = await as('mia')
    await put('personal', 'ANTHROPIC_BASE_URL', 'https://llm.example.com/anthropic', mia)
    await put('personal', 'ANTHROPIC_AUTH_TOKEN', CUSTOM_TOKEN, mia)
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-2', machineSize: 'standard' }, bearer: await as('bob') })
    const [mine, bobs] = [...h.vercel.boxes.values()]
    expect(mine!.policy.allow['llm.example.com']).toEqual([])
    expect(bobs!.policy.allow['llm.example.com']).toBeUndefined()
  })

  it('an edit reaches running sessions of that owner without a restart', async () => {
    const { h, as, put, commandEnv } = await setup()
    const ada = await as('ada', 'acme', 'admin')
    const mia = await as('mia', 'acme', 'member')
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-x', machineSize: 'standard' }, bearer: await as('zed', 'other', 'admin') })
    const starts = h.vercel.commands.filter((c) => c.command === START_COMMAND).length
    await put('org', 'ANTHROPIC_API_KEY', ORG_KEY, ada)
    const refreshes = h.vercel.commands.filter((c) => c.command === ENV_COMMAND)
    expect(refreshes).toHaveLength(1)
    expect(commandEnv(ENV_COMMAND)).toEqual({ ANTHROPIC_API_KEY: ORG_KEY })
    // No reboot, no new orcad.
    expect(h.vercel.commands.filter((c) => c.command === START_COMMAND)).toHaveLength(starts)
    await put('personal', 'MY_FLAG', 'on', mia)
    expect(commandEnv(ENV_COMMAND)).toEqual({ ANTHROPIC_API_KEY: ORG_KEY, MY_FLAG: 'on' })
    await h.call('DELETE', '/v1/secrets/personal/MY_FLAG', { bearer: mia })
    expect(commandEnv(ENV_COMMAND)).toEqual({ ANTHROPIC_API_KEY: ORG_KEY })
  })

  it('explicit refresh route reports whether the VM applied it', async () => {
    const { h, as } = await setup()
    const mia = await as('mia')
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    const id = created.body.sandbox.id
    expect((await h.call('POST', `/v1/sandboxes/${id}/env/refresh`, { bearer: mia })).body).toEqual({ applied: true })
    h.vercel.failEnvRefresh = true
    expect((await h.call('POST', `/v1/sandboxes/${id}/env/refresh`, { bearer: mia })).body).toEqual({ applied: false })
    expect((await h.call('POST', `/v1/sandboxes/${id}/env/refresh`, { bearer: await as('bob') })).status).toBe(404)
  })

  it('with placeholders on, a refresh that adds a gateway key routes it before the VM sees the placeholder', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256')
    const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'v1', alg: 'RS256' }] }
    const upstream: { url: string; headers: Headers }[] = []
    const { h, as, put, commandEnv } = await setup(
      { SECRETS_EGRESS_PLACEHOLDERS: 'on', EGRESS_PROXY_URL: PROXY_URL },
      {
        egressKeysForIssuer: () => createLocalJWKSet(jwks),
        credentials: { authorizationFor: async () => null },
        egressFetch: async (input, init) => {
          upstream.push({ url: String(input), headers: new Headers(init?.headers) })
          return new Response('event: message_stop\ndata: {}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }
      }
    )
    const mia = await as('mia')
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    const id: string = created.body.sandbox.id
    await put('personal', 'AI_GATEWAY_API_KEY', GATEWAY_KEY, mia)
    const env = commandEnv(ENV_COMMAND)
    const placeholder = `orca-ph-anthropic-auth-token-${id}`
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(placeholder)
    expect(env.OPENAI_API_KEY).toBe(`orca-ph-openai-api-key-${id}`)
    expect(env.AI_GATEWAY_API_KEY).toBe(`orca-ph-ai-gateway-api-key-${id}`)
    expect(JSON.stringify(env)).not.toContain(GATEWAY_KEY)
    const box = [...h.vercel.boxes.values()][0]!
    expect(box.policy.allow['ai-gateway.vercel.sh']!.at(-1)).toEqual({ response: { statusCode: 403, body: 'orca-egress-denied', contentType: 'text/plain' } })
    const oidc = await new SignJWT({ team_id: 'team_orca', project_id: 'prj_orca', sandbox_name: `orca-test-${id}` })
      .setProtectedHeader({ alg: 'RS256', kid: 'v1' })
      .setIssuer('https://oidc.vercel.com/team_orca')
      .setAudience(PROXY_URL)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    const res = await h.send(
      new Request(`${PROXY_URL}/v1/messages`, {
        method: 'POST',
        body: '{"stream":true}',
        headers: {
          'vercel-forwarded-host': 'ai-gateway.vercel.sh',
          'vercel-forwarded-scheme': 'https',
          'vercel-forwarded-port': '443',
          'vercel-forwarded-path': '/v1/messages',
          'vercel-sandbox-oidc-token': oidc,
          authorization: `Bearer ${placeholder}`
        }
      })
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('message_stop')
    expect(upstream.at(-1)!.url).toBe('https://ai-gateway.vercel.sh/v1/messages')
    expect(upstream.at(-1)!.headers.get('authorization')).toBe(`Bearer ${GATEWAY_KEY}`)

    // A real OpenAI key replaces the gateway-derived one. Even if the row still names the old
    // route (a refresh that lost a race), the proxy never sends the new key to the gateway.
    const stale = (await h.env.SANDBOX_DB.prepare('SELECT egress_secret_hosts FROM sandboxes WHERE id = ?').bind(id).first<{ egress_secret_hosts: string }>())!
    await put('personal', 'OPENAI_API_KEY', 'sk-proj-REAL-openai-fake-4444-eeee', mia)
    await h.env.SANDBOX_DB.prepare('UPDATE sandboxes SET egress_secret_hosts = ? WHERE id = ?').bind(stale.egress_secret_hosts, id).run()
    const sent = upstream.length
    const moved = await h.send(
      new Request(`${PROXY_URL}/v1/responses`, {
        method: 'POST',
        body: '{}',
        headers: {
          'vercel-forwarded-host': 'ai-gateway.vercel.sh',
          'vercel-forwarded-scheme': 'https',
          'vercel-forwarded-port': '443',
          'vercel-forwarded-path': '/v1/responses',
          'vercel-sandbox-oidc-token': oidc,
          authorization: `Bearer orca-ph-openai-api-key-${id}`
        }
      })
    )
    expect(moved.status).toBe(403)
    expect(upstream).toHaveLength(sent)
    // The VM was told the newer env (ordered writes).
    const refreshes = h.vercel.commands.filter((c) => c.command === ENV_COMMAND)
    expect(Number(refreshes.at(-1)!.env.ORCA_ENV_GENERATION)).toBeGreaterThan(0)
  })
})

describe('staged egress placeholder rollout', () => {
  it('swaps keys only for listed accounts', async () => {
    const { h, as, put, commandEnv } = await setup({ SECRETS_EGRESS_PLACEHOLDERS: 'accounts:org:acme', EGRESS_PROXY_URL: PROXY_URL })
    const ada = await as('ada', 'acme', 'admin')
    await put('personal', 'ANTHROPIC_API_KEY', PERSONAL_KEY, ada)
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: ada })
    expect(commandEnv(START_COMMAND).ANTHROPIC_API_KEY).toMatch(/^orca-ph-anthropic-api-key-sbx_/)
    const bob = await as('bob')
    await put('personal', 'ANTHROPIC_API_KEY', PERSONAL_KEY, bob)
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-2', machineSize: 'standard' }, bearer: bob })
    expect(commandEnv(START_COMMAND).ANTHROPIC_API_KEY).toBe(PERSONAL_KEY)
  })

  it('is on by default for every team, with a per-team kill switch', async () => {
    const { h, as, put, commandEnv } = await setup({ SECRETS_EGRESS_PLACEHOLDERS_OFF: 'org:legacy', EGRESS_PROXY_URL: PROXY_URL })
    const ada = await as('ada', 'acme', 'admin')
    await put('personal', 'ANTHROPIC_API_KEY', PERSONAL_KEY, ada)
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: ada })
    expect(commandEnv(START_COMMAND).ANTHROPIC_API_KEY).toMatch(/^orca-ph-anthropic-api-key-sbx_/)
    const lee = await as('lee', 'legacy', 'admin')
    await put('personal', 'ANTHROPIC_API_KEY', PERSONAL_KEY, lee)
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-2', machineSize: 'standard' }, bearer: lee })
    expect(commandEnv(START_COMMAND).ANTHROPIC_API_KEY).toBe(PERSONAL_KEY)
  })

  it("a member's personal base URL never routes the org's shared key to the member's host", async () => {
    const { h, as, put } = await setup({ SECRETS_EGRESS_PLACEHOLDERS: 'on', EGRESS_PROXY_URL: PROXY_URL })
    const ada = await as('ada', 'acme', 'admin')
    const mia = await as('mia', 'acme', 'member')
    await put('org', 'ANTHROPIC_API_KEY', ORG_KEY, ada)
    await put('org', 'OPENAI_API_KEY', 'sk-proj-ORGSHARED-fake-3333-dddd', ada)
    await put('personal', 'ANTHROPIC_BASE_URL', 'https://attacker.example.com', mia)
    await put('personal', 'OPENAI_BASE_URL', 'https://attacker.example.com/v1', mia)
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    const box = [...h.vercel.boxes.values()][0]!
    // The org keys stay routed to their real hosts; the member's host gets no credential route.
    expect(box.policy.allow['attacker.example.com']).toEqual([])
    expect(box.policy.allow['api.anthropic.com']!.length).toBeGreaterThan(1)
    expect(box.policy.allow['api.openai.com']!.length).toBeGreaterThan(1)
    const row = await h.env.SANDBOX_DB.prepare('SELECT egress_secret_hosts FROM sandboxes').first<{ egress_secret_hosts: string }>()
    expect(row!.egress_secret_hosts).toBe('ANTHROPIC_API_KEY@api.anthropic.com,OPENAI_API_KEY@api.openai.com')
  })

  it('a base URL from the same scope as its key does route that key', async () => {
    const { h, as, put } = await setup({ SECRETS_EGRESS_PLACEHOLDERS: 'on', EGRESS_PROXY_URL: PROXY_URL })
    const ada = await as('ada', 'acme', 'admin')
    await put('org', 'ANTHROPIC_BASE_URL', 'https://llm.example.com', ada)
    await put('org', 'ANTHROPIC_AUTH_TOKEN', CUSTOM_TOKEN, ada)
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: await as('mia', 'acme', 'member') })
    const row = await h.env.SANDBOX_DB.prepare('SELECT egress_secret_hosts FROM sandboxes').first<{ egress_secret_hosts: string }>()
    expect(row!.egress_secret_hosts).toBe('ANTHROPIC_AUTH_TOKEN@llm.example.com')
  })
})

describe('workspace tool hosts (synced remote MCP servers)', () => {
  it('opens declared hosts on the running sandbox now and on every later boot; refuses wildcards and private names', async () => {
    const { h, as } = await setup()
    const mia = await as('mia')
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    const id: string = created.body.sandbox.id
    const box = () => [...h.vercel.boxes.values()][0]!
    expect(box().policy.allow['mcp.linear.app']).toBeUndefined()
    const put = await h.call('PUT', `/v1/sandboxes/${id}/egress/hosts`, { bearer: mia, body: { hosts: ['MCP.linear.app', 'mcp.notion.com.', 'mcp.linear.app'] } })
    expect(put.body).toEqual({ hosts: ['mcp.linear.app', 'mcp.notion.com'] })
    expect(box().policy.allow['mcp.linear.app']).toEqual([])
    expect(box().policy.allow['*']).toBeUndefined()
    for (const bad of ['*', '*.example.com', '10.0.0.1', 'localhost', 'box.internal', 'http://x.example.com']) {
      expect((await h.call('PUT', `/v1/sandboxes/${id}/egress/hosts`, { bearer: mia, body: { hosts: [bad] } })).status).toBe(400)
    }
    expect((await h.call('PUT', `/v1/sandboxes/${id}/egress/hosts`, { bearer: await as('bob'), body: { hosts: ['x.example.com'] } })).status).toBe(404)
    // Sleep and wake: the hosts come back with the new session's policy.
    await h.call('POST', `/v1/sandboxes/${id}/suspend`, { bearer: mia })
    await h.call('POST', `/v1/sandboxes/${id}/resume`, { bearer: mia })
    expect(box().policy.allow['mcp.notion.com']).toEqual([])
    expect((await h.call('GET', `/v1/sandboxes/${id}/egress/hosts`, { bearer: mia })).body).toEqual({ hosts: ['mcp.linear.app', 'mcp.notion.com'] })
  })
})

describe('precedence is the same for plain injection and the egress swap', () => {
  // Agent keys: Shared (team) > Repository > Personal. Variables: Repository > Personal > Shared.
  async function egressKey(placeholders: 'on' | 'off', personal: boolean, team: boolean) {
    const { privateKey, publicKey } = await generateKeyPair('RS256')
    const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'v1', alg: 'RS256' }] }
    const upstream: Headers[] = []
    const { h, as, put, commandEnv } = await setup(
      { SECRETS_EGRESS_PLACEHOLDERS: placeholders, EGRESS_PROXY_URL: PROXY_URL },
      {
        egressKeysForIssuer: () => createLocalJWKSet(jwks),
        credentials: { authorizationFor: async () => null },
        egressFetch: async (_input, init) => {
          upstream.push(new Headers(init?.headers))
          return new Response('ok')
        }
      }
    )
    const ada = await as('ada', 'acme', 'admin')
    const mia = await as('mia', 'acme', 'member')
    if (team) {
      await put('org', 'ANTHROPIC_API_KEY', ORG_KEY, ada)
      await put('org', 'AWS_REGION', 'us-east-1', ada)
      await put('org', 'APP_MODE', 'team', ada)
    }
    if (personal) {
      await put('personal', 'ANTHROPIC_API_KEY', PERSONAL_KEY, mia)
      await put('personal', 'AWS_REGION', 'eu-west-1', mia)
      await put('personal', 'APP_MODE', 'mine', mia)
    }
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    const id: string = created.body.sandbox.id
    const env = commandEnv(START_COMMAND)
    if (placeholders === 'off') {
      return { key: env.ANTHROPIC_API_KEY, region: env.AWS_REGION, mode: env.APP_MODE }
    }
    const oidc = await new SignJWT({ team_id: 'team_orca', project_id: 'prj_orca', sandbox_name: `orca-test-${id}` })
      .setProtectedHeader({ alg: 'RS256', kid: 'v1' })
      .setIssuer('https://oidc.vercel.com/team_orca')
      .setAudience(PROXY_URL)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    await h.send(
      new Request(`${PROXY_URL}/v1/messages`, {
        method: 'POST',
        body: '{}',
        headers: {
          'vercel-forwarded-host': 'api.anthropic.com',
          'vercel-forwarded-scheme': 'https',
          'vercel-forwarded-port': '443',
          'vercel-forwarded-path': '/v1/messages',
          'vercel-sandbox-oidc-token': oidc,
          'x-api-key': env.ANTHROPIC_API_KEY!
        }
      })
    )
    return { key: upstream.at(-1)?.get('x-api-key'), region: env.AWS_REGION, mode: env.APP_MODE }
  }

  it('a team key beats a personal key in both modes; a personal key is used when the team has none', async () => {
    for (const mode of ['off', 'on'] as const) {
      expect(await egressKey(mode, true, true)).toEqual({ key: ORG_KEY, region: 'us-east-1', mode: 'mine' })
      expect((await egressKey(mode, true, false)).key).toBe(PERSONAL_KEY)
      expect((await egressKey(mode, false, true)).key).toBe(ORG_KEY)
    }
  })
})
