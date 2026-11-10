import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_CREDENTIAL_NAMES } from '../src/agent-credential-names'
import { ENV_COMMAND, START_COMMAND } from '../src/sandbox-vm-commands'
import { createHarness } from './harness'

const KEK = Buffer.alloc(32, 7).toString('base64')
const PROXY_URL = 'https://sandbox.test/v1/egress/proxy'
const TEAM_KEY = 'sk-ant-api03-TEAM-fake-0000-aaaa'
const GATEWAY_KEY = 'vck_fake-gateway-key-0000-aaaa-bbbb'

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
  for (const value of [TEAM_KEY, GATEWAY_KEY]) {
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
  const h = await createHarness({ SECRETS_KEK: KEK, ...overrides })
  const as = (sub: string, org?: string, role?: string, name?: string) =>
    h.token(sub, org, 'sandbox', { ...(role ? { orgRole: role } : {}), ...(name ? { name } : {}) })
  const put = (scope: string, name: string, value: string, bearer: string) =>
    h.call('PUT', `/v1/secrets/${scope}/${name}`, { body: { value }, bearer })
  const lastEnv = (command: string) => decode(h.vercel.commands.filter((c) => c.command === command).at(-1)?.env.ORCA_SECRET_ENV)
  return { h, as, put, lastEnv }
}

describe('per-agent credential names', () => {
  it('the Worker mirror matches the shared module verbatim', () => {
    const shared = readFileSync(fileURLToPath(new URL('../../../../src/shared/agent-credentials/agent-credential-names.ts', import.meta.url).href), 'utf8')
    for (const [agent, names] of Object.entries(AGENT_CREDENTIAL_NAMES)) {
      const block = new RegExp(`${agent}: \\[([^\\]]*)\\]`).exec(shared)?.[1] ?? ''
      expect(block.match(/'[A-Z0-9_]+'/g)?.map((n) => n.slice(1, -1))).toEqual([...names])
    }
  })
})

describe('/v1/agent-sources', () => {
  it('implicit default follows key coverage, explicit choices win, and the offer is per person', async () => {
    const { h, as, put } = await setup()
    const ada = await as('ada', 'acme', 'admin')
    const mia = await as('mia', 'acme', 'member')
    let view = await h.call('GET', '/v1/agent-sources', { bearer: mia })
    expect(view.body.effective).toEqual({ claude: { source: null, origin: 'implicit' }, codex: { source: null, origin: 'implicit' } })
    expect(view.body.signInOffer).toEqual({ claude: 'unanswered', codex: 'unanswered' })
    await put('org', 'ANTHROPIC_API_KEY', TEAM_KEY, ada)
    view = await h.call('GET', '/v1/agent-sources', { bearer: mia })
    expect(view.body.coveredByKey).toEqual({ claude: true, codex: false })
    expect(view.body.effective.claude).toEqual({ source: 'key', origin: 'implicit' })
    view = await h.call('PUT', '/v1/agent-sources', { bearer: mia, body: { agent: 'claude', source: 'sign-in' } })
    expect(view.body.effective.claude).toEqual({ source: 'sign-in', origin: 'default' })
    view = await h.call('PUT', '/v1/agent-sources/offer', { bearer: mia, body: { agent: 'claude', answer: 'declined' } })
    expect(view.body.signInOffer.claude).toBe('declined')
    // Ada's answers are hers alone.
    expect((await h.call('GET', '/v1/agent-sources', { bearer: ada })).body.signInOffer.claude).toBe('unanswered')
    expect((await h.call('PUT', '/v1/agent-sources', { bearer: mia, body: { agent: 'gemini', source: 'key' } })).status).toBe(400)
  })

  it('"Your sign-in" keeps that agent\'s credentials (incl. gateway-derived) out of the session, live, and only that agent\'s', async () => {
    const { h, as, put, lastEnv } = await setup({ SECRETS_EGRESS_PLACEHOLDERS: 'on', EGRESS_PROXY_URL: PROXY_URL })
    const ada = await as('ada', 'acme', 'admin')
    const mia = await as('mia', 'acme', 'member', 'Mia Chen')
    await put('org', 'AI_GATEWAY_API_KEY', GATEWAY_KEY, ada)
    await put('personal', 'APP_MODE', 'dev', mia)
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    const id: string = created.body.sandbox.id
    expect(Object.keys(lastEnv(START_COMMAND))).toEqual(expect.arrayContaining(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY']))
    const view = await h.call('PUT', '/v1/agent-sources', { bearer: mia, body: { agent: 'claude', source: 'sign-in', workspaceId: id } })
    expect(view.body.effective.claude).toEqual({ source: 'sign-in', origin: 'workspace' })
    expect(view.body.owner).toEqual({ userId: 'mia', displayName: 'Mia Chen', isCaller: true })
    const env = lastEnv(ENV_COMMAND)
    for (const name of AGENT_CREDENTIAL_NAMES.claude) {
      expect(env[name]).toBeUndefined()
    }
    expect(env.OPENAI_API_KEY).toMatch(/^orca-ph-openai-api-key-/)
    expect(env.APP_MODE).toBe('dev')
    const row = await h.env.SANDBOX_DB.prepare('SELECT egress_secret_hosts FROM sandboxes WHERE id = ?').bind(id).first<{ egress_secret_hosts: string }>()
    expect(row!.egress_secret_hosts).not.toContain('ANTHROPIC')
    // Back to the key: it returns in new shells.
    await h.call('PUT', '/v1/agent-sources', { bearer: mia, body: { agent: 'claude', source: null, workspaceId: id } })
    expect(lastEnv(ENV_COMMAND).ANTHROPIC_AUTH_TOKEN).toMatch(/^orca-ph-anthropic-auth-token-/)
  })

  it('a default applies to running sandboxes without an override; only the owner sets a workspace source', async () => {
    const { h, as, put, lastEnv } = await setup()
    const ada = await as('ada', 'acme', 'admin', 'Ada Lovelace')
    const mia = await as('mia', 'acme', 'member')
    await put('org', 'OPENAI_API_KEY', 'sk-proj-team-fake-1234-zzzz', ada)
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-ada', machineSize: 'standard' }, bearer: ada })
    const id: string = created.body.sandbox.id
    await h.call('PUT', '/v1/agent-sources', { bearer: ada, body: { agent: 'codex', source: 'sign-in' } })
    expect(lastEnv(ENV_COMMAND).OPENAI_API_KEY).toBeUndefined()
    const forbidden = await h.call('PUT', '/v1/agent-sources', { bearer: mia, body: { agent: 'codex', source: 'key', workspaceId: id } })
    expect(forbidden.status).toBe(403)
    expect(forbidden.body.reason).toBe('owner_only')
    const teammate = await h.call('GET', `/v1/agent-sources?workspaceId=${id}`, { bearer: mia })
    expect(teammate.body.owner).toEqual({ userId: 'ada', displayName: 'Ada Lovelace', isCaller: false })
    expect(teammate.body.effective.codex).toEqual({ source: 'sign-in', origin: 'default' })
    expect((await h.call('GET', `/v1/agent-sources?workspaceId=${id}`, { bearer: await as('zed', 'other', 'admin') })).status).toBe(404)
  })

  it('a workspace source set while the sandbox is still starting applies at its first boot (D9)', async () => {
    const { h, as, put, lastEnv } = await setup()
    const mia = await as('mia')
    await put('personal', 'ANTHROPIC_API_KEY', TEAM_KEY, mia)
    const id = 'sbx_creating_fake'
    await h.env.SANDBOX_DB.prepare(
      `INSERT INTO sandboxes (id, account_id, user_id, workspace_id, provider, provider_name, status, machine_size, region, generation, created_at, updated_at)
       VALUES (?, 'user:mia', 'mia', 'ws-c', 'vercel', 'orca-test-x', 'creating', 'standard', 'iad1', 0, 1, 1)`
    ).bind(id).run()
    const put1 = await h.call('PUT', '/v1/agent-sources', { bearer: mia, body: { agent: 'claude', source: 'sign-in', workspaceId: id } })
    expect(put1.status).toBe(200)
    expect(put1.body.effective.claude.source).toBe('sign-in')
  })
})
