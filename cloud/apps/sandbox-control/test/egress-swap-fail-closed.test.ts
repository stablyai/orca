// EGRESS-SWAP-FAIL-CLOSED: a deployed env (not local/test) without EGRESS_PROXY_URL can't swap keys at egress.
// Model keys and Orca-account sign-ins are withheld (the VM gets placeholders, the firewall answers them with a
// plain error), the session logs egress_swap_unavailable once (error level, counts only), and /v1/health fails the
// post-deploy smoke with keySwap "off".
// Local and test keep today's behaviour.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KEYS_WITHHELD_MESSAGE, compileNetworkPolicy } from '../src/network-policy'
import { START_COMMAND } from '../src/sandbox-vm-commands'
import { createHarness } from './harness'

const KEK = Buffer.alloc(32, 7).toString('base64')
const KEY = 'sk-ant-api03-WITHHELD-fake-0000-aaaa'
const SETUP_TOKEN = 'sk-ant-oat01-FAKEsetupTOKEN_for_tests_only_000000000000'

let logs: string[] = []
beforeEach(() => {
  logs = []
  errors = []
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      const line = args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')
      logs.push(line)
      if (method === 'error') {
        errors.push(line)
      }
    })
  }
})
afterEach(() => {
  expect(logs.join('\n')).not.toContain(KEY)
  expect(logs.join('\n')).not.toContain(SETUP_TOKEN)
  vi.restoreAllMocks()
})

async function setup(env: Record<string, string>) {
  const h = await createHarness({ SECRETS_KEK: KEK, SECRETS_EGRESS_PLACEHOLDERS: 'on', AGENT_ACCOUNTS_CLAUDE: 'on', ...env })
  const mia = await h.token('mia', undefined, 'sandbox')
  return { h, mia }
}

function startEnv(h: Awaited<ReturnType<typeof createHarness>>): Record<string, string> {
  const start = h.vercel.commands.filter((c) => c.command === START_COMMAND).at(-1)!
  return Object.fromEntries(
    (start.env.ORCA_SECRET_ENV ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), Buffer.from(line.slice(line.indexOf('=') + 1), 'base64').toString('utf8')])
  )
}

let errors: string[] = []
const withheldEvents = () => errors.filter((line) => line.includes('"event":"egress_swap_unavailable"'))

describe('EGRESS-SWAP-FAIL-CLOSED', () => {
  it('a deployed env without the proxy withholds model keys: placeholder in the VM, the firewall answers it with a plain error', async () => {
    const { h, mia } = await setup({ SANDBOX_ENV: 'staging' })
    await h.call('PUT', '/v1/secrets/personal/ANTHROPIC_API_KEY', { body: { value: KEY }, bearer: mia })
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    expect(created.status).toBe(200)
    const id: string = created.body.sandbox.id
    const env = startEnv(h)
    expect(env.ANTHROPIC_API_KEY).toBeDefined()
    expect(env.ANTHROPIC_API_KEY).not.toBe(KEY)
    expect(JSON.stringify(h.vercel.commands)).not.toContain(KEY)
    const box = [...h.vercel.boxes.values()][0]!
    expect(JSON.stringify(box.policy)).not.toContain(KEY)
    // Limited (E3-PROD-GUARD), and the key's host answers its placeholder itself.
    expect(box.policy.allow['*']).toBeUndefined()
    const rules = box.policy.allow['api.anthropic.com']!
    const answer = rules.find((rule) => 'response' in rule && 'match' in rule && rule.match)
    expect(answer).toMatchObject({
      match: { headers: [{ key: { exact: 'x-api-key' }, value: { exact: env.ANTHROPIC_API_KEY } }] },
      response: { statusCode: 403, contentType: 'application/json' }
    })
    expect(JSON.parse((answer as { response: { body: string } }).response.body).error.message).toBe(KEYS_WITHHELD_MESSAGE)
    expect(rules.at(-1)).toMatchObject({ response: { statusCode: 403, body: 'orca-egress-denied' } })
    // Logged once for the session at error level, however many times its env is read: a count, no names.
    expect(withheldEvents()).toHaveLength(1)
    expect(JSON.parse(withheldEvents()[0]!)).toEqual({ event: 'egress_swap_unavailable', sandboxId: id, environment: 'staging', withheld: 1 })
    expect(withheldEvents()[0]).not.toContain('ANTHROPIC')
    await h.call('POST', `/v1/sandboxes/${id}/env/refresh`, { bearer: mia })
    expect(withheldEvents()).toHaveLength(1)
  })

  it('an Orca-account sign-in is withheld the same way: account placeholder only, answered by the firewall', async () => {
    const { h, mia } = await setup({ SANDBOX_ENV: 'staging' })
    expect((await h.call('PUT', '/v1/agent-credentials/claude', { bearer: mia, body: { token: SETUP_TOKEN } })).status).toBe(200)
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    const env = startEnv(h)
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toMatch(/^orca-ph-claude-account-/)
    const box = [...h.vercel.boxes.values()][0]!
    expect(JSON.stringify(box.policy)).not.toContain(SETUP_TOKEN)
    expect(box.policy.allow['api.anthropic.com']![0]).toMatchObject({
      match: { headers: [{ key: { exact: 'authorization' }, value: { exact: `Bearer ${env.CLAUDE_CODE_OAUTH_TOKEN}` } }] },
      response: { statusCode: 403 }
    })
  })

  it('a deployed env with the proxy behaves as today: placeholder forwarded to the proxy, no event', async () => {
    const { h, mia } = await setup({ SANDBOX_ENV: 'staging', EGRESS_PROXY_URL: 'https://sandbox.test/v1/egress/proxy' })
    await h.call('PUT', '/v1/secrets/personal/ANTHROPIC_API_KEY', { body: { value: KEY }, bearer: mia })
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    const env = startEnv(h)
    expect(env.ANTHROPIC_API_KEY).not.toBe(KEY)
    const box = [...h.vercel.boxes.values()][0]!
    expect(box.policy.allow['*']).toEqual([])
    expect(box.policy.allow['api.anthropic.com']![0]).toMatchObject({ forwardURL: 'https://sandbox.test/v1/egress/proxy' })
    expect(JSON.stringify(box.policy)).not.toContain(KEYS_WITHHELD_MESSAGE)
    expect(withheldEvents()).toHaveLength(0)
  })

  it('test and local keep today’s behaviour without a proxy: plain env injection, no event', async () => {
    const { h, mia } = await setup({ SANDBOX_ENV: 'test' })
    await h.call('PUT', '/v1/secrets/personal/ANTHROPIC_API_KEY', { body: { value: KEY }, bearer: mia })
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    expect(startEnv(h).ANTHROPIC_API_KEY).toBe(KEY)
    expect(withheldEvents()).toHaveLength(0)
    // The plain key appears in the env on purpose here; keep it out of the afterEach log check.
    logs = logs.filter((line) => !line.includes(KEY))
  })

  it('placeholders turned off by an operator: plain keys as before, but logged once per session (count only)', async () => {
    const { h, mia } = await setup({ SANDBOX_ENV: 'staging', EGRESS_PROXY_URL: 'https://sandbox.test/v1/egress/proxy', SECRETS_EGRESS_PLACEHOLDERS: 'off' })
    await h.call('PUT', '/v1/secrets/personal/ANTHROPIC_API_KEY', { body: { value: KEY }, bearer: mia })
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    expect(startEnv(h).ANTHROPIC_API_KEY).toBe(KEY)
    await h.call('POST', `/v1/sandboxes/${created.body.sandbox.id}/env/refresh`, { bearer: mia })
    const disabled = logs.filter((line) => line.includes('"event":"egress_swap_disabled"'))
    expect(disabled).toHaveLength(1)
    expect(JSON.parse(disabled[0]!)).toEqual({ event: 'egress_swap_disabled', sandboxId: created.body.sandbox.id, plainKeys: 1 })
    logs = logs.filter((line) => !line.includes(KEY))
  })

  it('the egress proxy refuses outright in a deployed env without its URL (second lock)', async () => {
    const { h } = await setup({ SANDBOX_ENV: 'staging', VERCEL_TEAM_ID: 'team_x', VERCEL_PROJECT_ID: 'prj_x' })
    const res = await h.send(new Request('https://sandbox.test/v1/egress/proxy/v1/messages', { method: 'POST', headers: { 'vercel-forwarded-host': 'api.anthropic.com' } }))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'egress_proxy_missing' })
  })

  it('/v1/health is 503 egress_proxy_missing in a deployed env without the proxy, 200 with it or in local/test', async () => {
    const missing = await setup({ SANDBOX_ENV: 'staging' })
    expect(await missing.h.call('GET', '/v1/health')).toEqual({ status: 503, body: { error: 'egress_proxy_missing', keySwap: 'off' } })
    const present = await setup({ SANDBOX_ENV: 'staging', EGRESS_PROXY_URL: 'https://sandbox.test/v1/egress/proxy' })
    expect(await present.h.call('GET', '/v1/health')).toEqual({ status: 200, body: { ok: true, keySwap: 'on' } })
    const local = await setup({ SANDBOX_ENV: 'test' })
    expect(await local.h.call('GET', '/v1/health')).toEqual({ status: 200, body: { ok: true, keySwap: 'off' } })
  })

  it('a respond route compiles to a matched direct response, before the trailing deny', () => {
    const policy = compileNetworkPolicy({
      mode: 'allowlist',
      allowlist: [],
      credentials: [{ host: 'api.openai.com', header: 'Authorization', placeholders: ['Bearer orca-ph-x'], via: 'respond', statusCode: 403, body: '{"e":1}' }]
    })
    expect(policy.allow['api.openai.com']).toEqual([
      { match: { headers: [{ key: { exact: 'authorization' }, value: { exact: 'Bearer orca-ph-x' } }] }, response: { statusCode: 403, body: '{"e":1}', contentType: 'application/json' } },
      { response: { statusCode: 403, body: 'orca-egress-denied', contentType: 'text/plain' } }
    ])
  })
})
