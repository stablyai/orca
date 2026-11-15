// "Sign in inside this workspace": a per-person default Source under which Orca stores and injects
// nothing for that agent, so the agent's own login inside the sandbox reaches the vendor untouched.
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ENV_COMMAND, START_COMMAND } from '../src/sandbox-vm-commands'
import { createHarness } from './harness'

const KEK = Buffer.alloc(32, 7).toString('base64')
const PROXY_URL = 'https://sandbox.test/v1/egress/proxy'
const SETUP_TOKEN = 'sk-ant-oat01-FAKEsetupTOKEN_for_tests_only_000000000000'
const TEAM_KEY = 'sk-ant-api03-TEAM-fake-0000-aaaa'
const OPENAI_KEY = 'sk-proj-FAKE-openai-0000-bbbb'

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
  for (const value of [SETUP_TOKEN, TEAM_KEY, OPENAI_KEY]) {
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

/** Vendor hosts the agents' own sign-in and model calls use. */
const VENDOR_HOSTS = ['api.anthropic.com', 'claude.ai', 'platform.claude.com', 'console.anthropic.com', 'chatgpt.com', 'auth.openai.com', 'api.openai.com']

async function setup(overrides: Record<string, string> = {}) {
  const h = await createHarness({
    SECRETS_KEK: KEK,
    EGRESS_PROXY_URL: PROXY_URL,
    SECRETS_EGRESS_PLACEHOLDERS: 'on',
    AGENT_ACCOUNTS_CLAUDE: 'on',
    ...overrides
  })
  const as = (sub: string, org?: string, role?: string) => h.token(sub, org, 'sandbox', role ? { orgRole: role } : {})
  const lastEnv = (command: string) => decode(h.vercel.commands.filter((c) => c.command === command).at(-1)?.env.ORCA_SECRET_ENV)
  const policy = () => [...h.vercel.boxes.values()].at(-1)!.policy.allow
  return { h, as, lastEnv, policy }
}

describe('Source "in-workspace" (sign in inside this workspace)', () => {
  it('injects nothing for that agent even with a stored account and a team key, and leaves its hosts unruled', async () => {
    const { h, as, lastEnv, policy } = await setup()
    const ada = await as('ada', 'acme', 'admin')
    const mia = await as('mia', 'acme', 'member')
    await h.call('PUT', '/v1/secrets/org/ANTHROPIC_API_KEY', { bearer: ada, body: { value: TEAM_KEY } })
    await h.call('PUT', '/v1/secrets/personal/OPENAI_API_KEY', { bearer: mia, body: { value: OPENAI_KEY } })
    await h.call('PUT', '/v1/agent-credentials/claude', { bearer: mia, body: { token: SETUP_TOKEN } })
    for (const agent of ['claude', 'codex']) {
      const put = await h.call('PUT', '/v1/agent-sources', { bearer: mia, body: { agent, source: 'in-workspace' } })
      expect(put.status).toBe(200)
    }
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    const env = lastEnv(START_COMMAND)
    for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ORCA_CODEX_AUTH_PLACEHOLDER']) {
      expect(env[name]).toBeUndefined()
    }
    expect(Object.values(env).some((value) => value.startsWith('orca-ph-'))).toBe(false)
    // Open egress: "*" plus only hosts that carry rules. No vendor host carries one (no claim, no 403).
    const allow = policy()
    expect(allow['*']).toEqual([])
    for (const host of VENDOR_HOSTS) {
      expect(allow[host]).toBeUndefined()
    }
    const view = (await h.call('GET', '/v1/agent-sources', { bearer: mia })).body
    expect(view.inWorkspace).toEqual({ claude: true, codex: true })
    // Older desktops read `defaults` and `effective.source` with two values only: neither ever says 'in-workspace'.
    expect(view.defaults).toEqual({ claude: null, codex: null })
    expect(view.effective.claude).toEqual({ source: null, origin: 'default' })
  })

  it('limited egress still reaches every vendor sign-in and API host unmodified', async () => {
    const { h, as, policy } = await setup({ SANDBOX_EGRESS_PRESET: 'limited' })
    const mia = await as('mia')
    await h.call('PUT', '/v1/agent-credentials/claude', { bearer: mia, body: { token: SETUP_TOKEN } })
    await h.call('PUT', '/v1/agent-sources', { bearer: mia, body: { agent: 'claude', source: 'in-workspace' } })
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    const allow = policy()
    expect(allow['*']).toBeUndefined()
    const reachable = (host: string) => {
      const parent = `*.${host.split('.').slice(1).join('.')}`
      return allow[host] ?? allow[parent]
    }
    for (const host of VENDOR_HOSTS) {
      expect(reachable(host), host).toEqual([])
    }
  })

  it('switching a running workspace\'s owner to it drops the account placeholder live; choosing the account again brings it back', async () => {
    const { h, as, lastEnv } = await setup()
    const mia = await as('mia')
    await h.call('PUT', '/v1/agent-credentials/claude', { bearer: mia, body: { token: SETUP_TOKEN } })
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    const id: string = created.body.sandbox.id
    expect(lastEnv(START_COMMAND).CLAUDE_CODE_OAUTH_TOKEN).toBe(`orca-ph-claude-account-${id}`)
    await h.call('PUT', '/v1/agent-sources', { bearer: mia, body: { agent: 'claude', source: 'in-workspace' } })
    expect(lastEnv(ENV_COMMAND).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect([...h.vercel.boxes.values()][0]!.policy.allow['api.anthropic.com']).toBeUndefined()
    await h.call('PUT', '/v1/agent-sources', { bearer: mia, body: { agent: 'claude', source: null } })
    expect(lastEnv(ENV_COMMAND).CLAUDE_CODE_OAUTH_TOKEN).toBe(`orca-ph-claude-account-${id}`)
  })

  it('is a per-person default only: a workspace override is refused, and an explicit workspace Source still wins', async () => {
    const { h, as, lastEnv } = await setup()
    const mia = await as('mia')
    await h.call('PUT', '/v1/agent-credentials/claude', { bearer: mia, body: { token: SETUP_TOKEN } })
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    const id: string = created.body.sandbox.id
    const refused = await h.call('PUT', '/v1/agent-sources', { bearer: mia, body: { agent: 'claude', source: 'in-workspace', workspaceId: id } })
    expect(refused.status).toBe(400)
    await h.call('PUT', '/v1/agent-sources', { bearer: mia, body: { agent: 'claude', source: 'sign-in', workspaceId: id } })
    await h.call('PUT', '/v1/agent-sources', { bearer: mia, body: { agent: 'claude', source: 'in-workspace' } })
    expect(lastEnv(ENV_COMMAND).CLAUDE_CODE_OAUTH_TOKEN).toBe(`orca-ph-claude-account-${id}`)
  })

  it('the migration keeps every row written before the table was widened', () => {
    const dir = fileURLToPath(new URL('../migrations/', import.meta.url).href)
    const files = readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()
    const widen = files.indexOf('0062_agent_sources_in_workspace.sql')
    expect(widen).toBeGreaterThan(0)
    const raw = new DatabaseSync(':memory:')
    for (const file of files.slice(0, widen)) {
      raw.exec(readFileSync(`${dir}${file}`, 'utf8'))
    }
    const insert = raw.prepare('INSERT INTO agent_sources (user_id, account_id, scope, agent, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    insert.run('mia', 'acme', 'default', 'codex', 'key', 1)
    insert.run('mia', 'acme', 'offer', 'claude', 'declined', 2)
    insert.run('mia', 'acme', 'sbx-1', 'claude', 'sign-in', 3)
    expect(() => insert.run('mia', 'acme', 'default', 'claude', 'in-workspace', 4)).toThrow(/CHECK/)
    raw.exec(readFileSync(`${dir}${files[widen]}`, 'utf8'))
    insert.run('mia', 'acme', 'default', 'claude', 'in-workspace', 4)
    expect(raw.prepare('SELECT scope, agent, source, updated_at FROM agent_sources ORDER BY updated_at').all()).toEqual([
      { scope: 'default', agent: 'codex', source: 'key', updated_at: 1 },
      { scope: 'offer', agent: 'claude', source: 'declined', updated_at: 2 },
      { scope: 'sbx-1', agent: 'claude', source: 'sign-in', updated_at: 3 },
      { scope: 'default', agent: 'claude', source: 'in-workspace', updated_at: 4 }
    ])
    expect(() => insert.run('mia', 'acme', 'default', 'claude', 'bogus', 5)).toThrow(/CHECK/)
    expect(raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_sources'`).all()).toContainEqual({ name: 'agent_sources_scope' })
  })
})
