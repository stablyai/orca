// Codex via the person's Orca account (contract D11, flag S2): the broker sandbox login, the lease refresher,
// the placeholder auth.json and the chatgpt.com egress swap. Fake provider; no real OpenAI call.
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BROKER_AUTH_PATH, BROKER_EXIT_PATH, BROKER_START_MARKER, parseDeviceCode } from '../src/codex-broker'
import { CODEX_TOKEN_URL, codexPlaceholder, refreshCodexCredential, refreshCodexLeases, setCodexTokenFetch } from '../src/codex-credentials'
import { codexTick } from '../src/index'
import { createKeyring } from '../src/secrets-crypto'
import { START_COMMAND } from '../src/sandbox-vm-commands'
import { createHarness } from './harness'

const KEK = Buffer.alloc(32, 7).toString('base64')
const PROXY_URL = 'https://sandbox.test/v1/egress/proxy'
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const jwt = (claims: Record<string, unknown>) => `${b64url({ alg: 'RS256' })}.${b64url(claims)}.sig-${Math.random().toString(36).slice(2)}`
const T0 = 1_800_000_000_000
const ACCESS = jwt({ exp: T0 / 1000 + 10 * 86_400, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } })
const REFRESH = 'rt_FAKE_refresh_token_0000000000000000'
const ID = jwt({ email: 'mia@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1', chatgpt_plan_type: 'plus' } })
const ACCESS_2 = jwt({ exp: T0 / 1000 + 20 * 86_400 })
const REFRESH_2 = 'rt_FAKE_refresh_token_1111111111111111'
const AUTH_JSON = JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: ID, access_token: ACCESS, refresh_token: REFRESH, account_id: 'acct-1' }, last_refresh: 'x' })
const SECRETS = [ACCESS, REFRESH, ACCESS_2, REFRESH_2, ID]
const DEVICE_OUTPUT = `${BROKER_START_MARKER}
Welcome to Codex [v0.166.0]
Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m

2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m
   \u001b[94mABCD-12EF\u001b[0m
`

/** Codex wrote auth.json and exited 0. */
function finishLogin(box: { files: Map<string, string> }) {
  box.files.set(BROKER_AUTH_PATH, AUTH_JSON)
  box.files.set(BROKER_EXIT_PATH, '0\n')
}

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
  setCodexTokenFetch(null)
  for (const value of SECRETS) {
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
  const tokenCalls: Record<string, unknown>[] = []
  const upstreamStatus = { value: 200 }
  let tokenReply: () => Response = () =>
    Response.json({ access_token: ACCESS_2, refresh_token: REFRESH_2, id_token: ID })
  const h = await createHarness(
    { SECRETS_KEK: KEK, EGRESS_PROXY_URL: PROXY_URL, SECRETS_EGRESS_PLACEHOLDERS: 'on', AGENT_ACCOUNTS_CODEX: 'on', ...overrides },
    {
      egressKeysForIssuer: () => createLocalJWKSet(jwks),
      credentials: { authorizationFor: async () => null },
      egressFetch: async (input, init) => {
        upstream.push({ url: String(input), headers: new Headers(init?.headers) })
        return new Response('{}', { status: upstreamStatus.value })
      },
      codexTokenFetch: async (input, init) => {
        expect(String(input)).toBe(CODEX_TOKEN_URL)
        tokenCalls.push(JSON.parse(String(init?.body)))
        return tokenReply()
      }
    }
  )
  setCodexTokenFetch(h.deps.codexTokenFetch!)
  h.vercel.commandHandler = (params) =>
    params.command === 'bash' && params.args?.[1]?.includes('--device-auth') ? { exitCode: 0, stdout: DEVICE_OUTPUT, stderr: '' } : undefined
  const as = (sub: string, org?: string, role?: string) => h.token(sub, org, 'sandbox', role ? { orgRole: role } : {})
  const brokerBox = () => [...h.vercel.boxes.values()].find((box) => box.params.tags.orcaCodexBroker)
  const lastEnv = (command: string) => decode(h.vercel.commands.filter((c) => c.command === command).at(-1)?.env.ORCA_SECRET_ENV)
  async function proxied(sandboxId: string, host: string, headers: Record<string, string>, path = '/backend-api/codex/responses', method = 'POST') {
    const oidc = await new SignJWT({ team_id: 'team_orca', project_id: 'prj_orca', sandbox_name: `orca-test-${sandboxId}` })
      .setProtectedHeader({ alg: 'RS256', kid: 'v1' })
      .setIssuer('https://oidc.vercel.com/team_orca')
      .setAudience(PROXY_URL)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    const response = await h.send(
      new Request(`${PROXY_URL}${path}`, {
        method,
        body: method === 'GET' ? undefined : '{}',
        headers: {
          'vercel-forwarded-host': host,
          'vercel-forwarded-scheme': 'https',
          'vercel-forwarded-port': '443',
          'vercel-forwarded-path': path,
          'vercel-sandbox-oidc-token': oidc,
          ...headers
        }
      })
    )
    return { status: response.status, body: await response.text() }
  }
  /** Signs `mia` in through the broker: POST, the person enters the code, Codex writes auth.json, GET. */
  async function signIn(bearer: string) {
    const started = await h.call('POST', '/v1/agent-credentials/codex/broker', { bearer })
    expect(started.status).toBe(200)
    finishLogin(brokerBox()!)
    const done = await h.call('GET', `/v1/agent-credentials/codex/broker/${started.body.brokerId}`, { bearer })
    expect(done.body).toEqual({ status: 'active' })
    return started.body.brokerId as string
  }
  const deps = () => ({
    db: h.env.SANDBOX_DB,
    keyring: createKeyring({ id: 'k1', key: KEK }),
    now: h.now,
    fetch: h.deps.codexTokenFetch
  })
  return {
    h,
    as,
    brokerBox,
    lastEnv,
    proxied,
    upstream,
    upstreamStatus,
    tokenCalls,
    signIn,
    refreshDeps: async () => ({ ...deps(), keyring: await deps().keyring }),
    setTokenReply: (reply: () => Response) => {
      tokenReply = reply
    }
  }
}

describe('device code parsing', () => {
  it('reads the link and the one-time code from codex login --device-auth output', () => {
    expect(parseDeviceCode(DEVICE_OUTPUT)).toEqual({ verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-12EF' })
    expect(parseDeviceCode(`${BROKER_START_MARKER}\nError: device code login is not enabled`)).toBeNull()
  })
})

describe('Codex broker (flag S2)', () => {
  it('is off without the flag and under the kill switch', async () => {
    for (const env of [{ AGENT_ACCOUNTS_CODEX: '' }, { AGENT_ACCOUNTS_CODEX_DISABLED: '1' }] as Record<string, string>[]) {
      const { h, as } = await setup(env)
      const res = await h.call('POST', '/v1/agent-credentials/codex/broker', { bearer: await as('mia') })
      expect(res.status).toBe(404)
      expect(h.vercel.boxes.size).toBe(0)
    }
  })

  it('logs in in an infra broker sandbox, stores the tokens Personal-only, never returns them, and destroys the broker', async () => {
    const { h, as, brokerBox } = await setup()
    const mia = await as('mia', 'acme', 'member')
    const started = await h.call('POST', '/v1/agent-credentials/codex/broker', { bearer: mia })
    expect(started.status).toBe(200)
    expect(started.body).toMatchObject({ verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-12EF' })
    expect(started.body.brokerId).toMatch(/^cxb_[a-f0-9]{20}$/)
    const box = brokerBox()!
    // Infra: tagged for its own sweep, no workspace tag (orphan sweep, billing), no snapshot, only sign-in hosts.
    expect(box.params.tags).toEqual({ orcaCodexBroker: started.body.brokerId, orcaEnv: 'test', orcaInfra: 'codex-broker' })
    expect(box.params.persistent).toBe(false)
    expect(box.params.vcpus).toBe(2)
    expect(Object.keys(box.policy.allow).sort()).toEqual(['auth.openai.com', 'chatgpt.com'])
    expect((await h.env.SANDBOX_DB.prepare('SELECT COUNT(*) AS n FROM sandboxes').first<{ n: number }>())!.n).toBe(0)
    // A second POST while the code is live reuses it (no second VM).
    expect((await h.call('POST', '/v1/agent-credentials/codex/broker', { bearer: mia })).body.brokerId).toBe(started.body.brokerId)
    expect(h.vercel.boxes.size).toBe(1)

    const path = `/v1/agent-credentials/codex/broker/${started.body.brokerId}`
    expect((await h.call('GET', path, { bearer: mia })).body).toEqual({ status: 'pending' })
    // Someone else's broker id is not theirs to read.
    expect((await h.call('GET', path, { bearer: await as('bob', 'acme', 'member') })).status).toBe(404)

    // auth.json alone (Codex still running) is not a finished login.
    box.files.set(BROKER_AUTH_PATH, AUTH_JSON)
    expect((await h.call('GET', path, { bearer: mia })).body).toEqual({ status: 'pending' })
    finishLogin(box)
    const done = await h.call('GET', path, { bearer: mia })
    expect(done.body).toEqual({ status: 'active' })
    expect(brokerBox()).toBeUndefined()
    const view = await h.call('GET', '/v1/agent-credentials', { bearer: mia })
    expect(view.body.codex).toEqual({ state: 'active', label: 'mia@example.com' })
    expect(view.body.providerEnabled.codex).toBe(true)
    expect((await h.call('GET', '/v1/agent-credentials', { bearer: await as('bob', 'acme', 'member') })).body.codex.state).toBe('none')
    // Sealed at rest: no token in D1 in the clear.
    const row = await h.env.SANDBOX_DB.prepare(`SELECT * FROM agent_credentials WHERE agent = 'codex'`).first<Record<string, unknown>>()
    for (const secret of SECRETS) {
      expect(JSON.stringify(row)).not.toContain(secret)
      expect(JSON.stringify([started.body, done.body, view.body])).not.toContain(secret)
    }
  })

  it('fails and cleans up when the login ends without a token, when the code expires, or when no code appears', async () => {
    const { h, as, brokerBox } = await setup()
    const mia = await as('mia')
    const first = await h.call('POST', '/v1/agent-credentials/codex/broker', { bearer: mia })
    brokerBox()!.files.set(BROKER_EXIT_PATH, '1\n')
    expect((await h.call('GET', `/v1/agent-credentials/codex/broker/${first.body.brokerId}`, { bearer: mia })).body).toEqual({
      status: 'failed',
      error: 'login_failed'
    })
    expect(brokerBox()).toBeUndefined()

    const second = await h.call('POST', '/v1/agent-credentials/codex/broker', { bearer: mia })
    h.advance(16 * 60_000)
    await codexTick(h.env, false, h.deps)
    expect(brokerBox()).toBeUndefined()
    expect((await h.call('GET', `/v1/agent-credentials/codex/broker/${second.body.brokerId}`, { bearer: await as('mia') })).body.error).toBe('expired')

    // Cancel: the code dies with its sandbox.
    const cancelled = await h.call('POST', '/v1/agent-credentials/codex/broker', { bearer: await as('mia') })
    expect(brokerBox()).toBeDefined()
    expect((await h.call('DELETE', `/v1/agent-credentials/codex/broker/${cancelled.body.brokerId}`, { bearer: await as('bob') })).status).toBe(404)
    expect((await h.call('DELETE', `/v1/agent-credentials/codex/broker/${cancelled.body.brokerId}`, { bearer: await as('mia') })).body).toEqual({
      status: 'failed',
      error: 'cancelled'
    })
    expect(brokerBox()).toBeUndefined()

    h.vercel.commandHandler = (params) =>
      params.command === 'bash' ? { exitCode: 0, stdout: `${BROKER_START_MARKER}\nError: device code login is not enabled for this Codex server.`, stderr: '' } : undefined
    const third = await h.call('POST', '/v1/agent-credentials/codex/broker', { bearer: await as('mia') })
    expect(third).toEqual({ status: 502, body: { error: 'device_auth_disabled' } })
    expect(brokerBox()).toBeUndefined()
  })

  it('one live broker per person, even for racing POSTs; a cancel while starting never hands out the code', async () => {
    const { h, as } = await setup()
    const mia = await as('mia')
    const [a, b] = await Promise.all([
      h.call('POST', '/v1/agent-credentials/codex/broker', { bearer: mia }),
      h.call('POST', '/v1/agent-credentials/codex/broker', { bearer: mia })
    ])
    // Either the second sees the first's code (reused) or is refused while it starts; never two VMs.
    expect(a.status === 409 || b.status === 409 || a.body.brokerId === b.body.brokerId).toBe(true)
    expect([...h.vercel.boxes.values()].filter((box) => box.params.tags.orcaCodexBroker)).toHaveLength(1)
    const live = a.status === 200 ? a : b
    // Another POST while one is still starting (no code yet) is refused, not a second VM.
    h.raw.exec(`UPDATE codex_broker_sessions SET status = 'starting'`)
    expect(await h.call('POST', '/v1/agent-credentials/codex/broker', { bearer: mia })).toEqual({ status: 409, body: { error: 'broker_in_progress' } })
    h.raw.exec(`UPDATE codex_broker_sessions SET status = 'pending'`)
    await h.call('DELETE', `/v1/agent-credentials/codex/broker/${live.body.brokerId}`, { bearer: mia })

    // The person cancels while the broker is still starting (between create and the device code).
    h.vercel.commandHandler = (params) => {
      if (params.command === 'bash' && params.args?.[1]?.includes('--device-auth')) {
        h.raw.exec(`UPDATE codex_broker_sessions SET status = 'failed', error = 'cancelled' WHERE status = 'starting'`)
        return { exitCode: 0, stdout: DEVICE_OUTPUT, stderr: '' }
      }
      return undefined
    }
    const raced = await h.call('POST', '/v1/agent-credentials/codex/broker', { bearer: await as('mia') })
    expect(raced).toEqual({ status: 409, body: { error: 'cancelled' } })
    expect([...h.vercel.boxes.values()].filter((box) => box.params.tags.orcaCodexBroker)).toHaveLength(0)

    // At most 6 starts an hour per person (2 so far).
    h.vercel.commandHandler = (params) =>
      params.command === 'bash' && params.args?.[1]?.includes('--device-auth') ? { exitCode: 0, stdout: DEVICE_OUTPUT, stderr: '' } : undefined
    for (let i = 0; i < 4; i++) {
      const started = await h.call('POST', '/v1/agent-credentials/codex/broker', { bearer: mia })
      expect(started.status).toBe(200)
      await h.call('DELETE', `/v1/agent-credentials/codex/broker/${started.body.brokerId}`, { bearer: mia })
    }
    expect(await h.call('POST', '/v1/agent-credentials/codex/broker', { bearer: mia })).toEqual({ status: 429, body: { error: 'rate_limited' } })
  })

  it('the cron completes a login nobody polls, and deletes broker sandboxes D1 lost track of', async () => {
    const { h, as, brokerBox } = await setup()
    const mia = await as('mia')
    await h.call('POST', '/v1/agent-credentials/codex/broker', { bearer: mia })
    finishLogin(brokerBox()!)
    await codexTick(h.env, false, h.deps)
    expect(brokerBox()).toBeUndefined()
    expect((await h.call('GET', '/v1/agent-credentials', { bearer: mia })).body.codex.state).toBe('active')

    await h.call('POST', '/v1/agent-credentials/codex/broker', { bearer: await as('ann') })
    await h.env.SANDBOX_DB.prepare('DELETE FROM codex_broker_sessions').run()
    await codexTick(h.env, true, h.deps)
    expect(brokerBox()).toBeUndefined()
  })
})

describe('Codex account in workspaces (D10, D13)', () => {
  it('writes a placeholder login into the workspace and swaps the real access token on chatgpt.com only', async () => {
    const { h, as, signIn, lastEnv, proxied, upstream } = await setup()
    const mia = await as('mia', 'acme', 'member')
    await signIn(mia)
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    const id: string = created.body.sandbox.id
    const env = lastEnv(START_COMMAND)
    const placeholder = codexPlaceholder({ id })
    expect(env.ORCA_CODEX_AUTH_PLACEHOLDER).toBe(placeholder)
    for (const secret of SECRETS) {
      expect(JSON.stringify(env)).not.toContain(secret)
    }
    // Codex reads exp from it: far future, so the sandbox never tries to refresh.
    expect(JSON.parse(Buffer.from(placeholder.split('.')[1]!, 'base64url').toString()).exp).toBeGreaterThan(4e9)
    const box = [...h.vercel.boxes.values()].find((b) => b.params.tags.orcaSandbox === id)!
    expect(box.policy.allow['chatgpt.com']!.at(-1)).toEqual({ response: { statusCode: 403, body: 'orca-egress-denied', contentType: 'text/plain' } })
    expect((await proxied(id, 'chatgpt.com', { authorization: `Bearer ${placeholder}` })).status).toBe(200)
    expect(upstream.at(-1)!.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(upstream.at(-1)!.headers.get('authorization')).toBe(`Bearer ${ACCESS}`)
    expect(upstream.at(-1)!.headers.get('chatgpt-account-id')).toBe('acct-1')
    // Only Codex's own ChatGPT backend calls get the token: not conversations, memories or connectors.
    const auth = { authorization: `Bearer ${placeholder}` }
    expect((await proxied(id, 'chatgpt.com', auth, '/backend-api/codex/models?client_version=0.166.0', 'GET')).status).toBe(200)
    expect((await proxied(id, 'chatgpt.com', auth, '/backend-api/wham/usage', 'GET')).status).toBe(200)
    expect((await proxied(id, 'chatgpt.com', auth, '/backend-api/ps/plugins/list?scope=GLOBAL', 'GET')).status).toBe(200)
    for (const [path, method] of [
      ['/backend-api/conversation', 'POST'],
      ['/backend-api/memories', 'GET'],
      ['/backend-api/wham/apps', 'GET'],
      ['/backend-api/codex/../conversation', 'POST'],
      ['/backend-api/codex/%2e%2e/conversation', 'POST'],
      ['/backend-api/wham/usage', 'POST']
    ]) {
      expect((await proxied(id, 'chatgpt.com', auth, path!, method!)).body).toBe('path_not_allowed')
    }
    // Another sandbox's placeholder (a clone's, D14) is not this one's.
    expect((await proxied(id, 'chatgpt.com', { authorization: `Bearer ${codexPlaceholder({ id: 'sbx_other' })}` })).status).toBe(403)
  })

  it('a 401 from chatgpt.com refreshes the login instead of revoking it', async () => {
    const { h, as, signIn, proxied, upstreamStatus, tokenCalls } = await setup()
    const mia = await as('mia')
    await signIn(mia)
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    const id: string = created.body.sandbox.id
    h.advance(10 * 60_000)
    upstreamStatus.value = 401
    expect((await proxied(id, 'chatgpt.com', { authorization: `Bearer ${codexPlaceholder({ id })}` })).status).toBe(401)
    await vi.waitFor(() => expect(tokenCalls).toHaveLength(1))
    upstreamStatus.value = 200
    expect((await h.call('GET', '/v1/agent-credentials', { bearer: await as('mia') })).body.codex.state).toBe('active')
    // A second 401 right after the refresh does not spend another refresh token.
    upstreamStatus.value = 401
    await proxied(id, 'chatgpt.com', { authorization: `Bearer ${codexPlaceholder({ id })}` })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(tokenCalls).toHaveLength(1)
  })

  it('never swaps a personal Codex login into a workspace shared with teammates (D13)', async () => {
    const { h, as, signIn, lastEnv, proxied } = await setup()
    const mia = await as('mia', 'acme', 'member')
    await signIn(mia)
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    const id: string = created.body.sandbox.id
    await h.env.SANDBOX_DB.prepare(`UPDATE sandboxes SET visibility = 'team' WHERE id = ?`).bind(id).run()
    const refused = await proxied(id, 'chatgpt.com', { authorization: `Bearer ${codexPlaceholder({ id })}` })
    // RS-4: still a 403 (a 401 would start Codex's own token refresh), now with words Codex prints.
    expect(refused.status).toBe(403)
    expect(JSON.parse(refused.body)).toEqual({
      detail: 'Your ChatGPT sign-in for Orca Cloud isn’t available here. Renew it in Orca: Settings → Agent accounts.'
    })
    expect(lastEnv('/opt/orca/bin/orca-sandbox-env').ORCA_CODEX_AUTH_PLACEHOLDER).toBeUndefined()
  })

  it('kill switch: no placeholder and no swap, the stored login is kept; DELETE revokes it', async () => {
    const { h, as, signIn, proxied, lastEnv } = await setup()
    const mia = await as('mia')
    await signIn(mia)
    const off = { ...h.env, AGENT_ACCOUNTS_CODEX_DISABLED: '1' }
    Object.assign(h.env, off)
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    const id: string = created.body.sandbox.id
    expect(lastEnv(START_COMMAND).ORCA_CODEX_AUTH_PLACEHOLDER).toBeUndefined()
    expect((await proxied(id, 'chatgpt.com', { authorization: `Bearer ${codexPlaceholder({ id })}` })).status).toBe(403)
    expect((await h.call('GET', '/v1/agent-credentials', { bearer: mia })).body).toMatchObject({ codex: { state: 'active' }, providerEnabled: { codex: false } })
    h.env.AGENT_ACCOUNTS_CODEX_DISABLED = undefined
    expect((await h.call('DELETE', '/v1/agent-credentials/codex', { bearer: mia })).body.codex.state).toBe('none')
  })
})

describe('Codex lease refresher', () => {
  it('refreshes a due token once (single-flight), with the newest refresh token, and swaps the new token in', async () => {
    const { h, as, signIn, tokenCalls, refreshDeps } = await setup()
    await signIn(await as('mia'))
    // Not due yet: 10 days left.
    expect((await refreshCodexLeases(await refreshDeps())).due).toBe(0)
    h.advance(8 * 86_400_000)
    // Two refreshers at once (two isolates, a slow cron): exactly one token call.
    const deps = await refreshDeps()
    const [a, b] = await Promise.all([refreshCodexCredential(deps, 'mia'), refreshCodexCredential(deps, 'mia')])
    expect([a, b].sort()).toEqual(['refreshed', 'skipped'])
    expect(tokenCalls).toEqual([{ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', grant_type: 'refresh_token', refresh_token: REFRESH, scope: 'openid profile email' }])
    // The next refresh spends the rotated token, never the old one.
    h.advance(9 * 86_400_000)
    expect(await refreshCodexCredential(deps, 'mia')).toBe('refreshed')
    expect(tokenCalls.at(-1)!.refresh_token).toBe(REFRESH_2)
  })

  it('marks the login revoked on refresh_token_reused, expiring on a transient failure, and never resurrects a deleted one', async () => {
    const { h, as, signIn, refreshDeps, setTokenReply } = await setup()
    await signIn(await as('mia'))
    const view = async () => (await h.call('GET', '/v1/agent-credentials', { bearer: await as('mia') })).body.codex.state
    h.advance(8 * 86_400_000)
    setTokenReply(() => new Response('upstream down', { status: 503 }))
    expect(await refreshCodexCredential(await refreshDeps(), 'mia')).toBe('failed')
    expect(await view()).toBe('expiring')
    h.advance(3 * 86_400_000)
    expect(await view()).toBe('expired')

    setTokenReply(() => Response.json({ error: { code: 'refresh_token_reused', message: 'x' } }, { status: 401 }))
    expect(await refreshCodexCredential(await refreshDeps(), 'mia')).toBe('revoked')
    expect(await view()).toBe('revoked')

    // A dead login (refresh_token_expired) is not retried every tick.
    await signIn(await as('mia'))
    h.advance(8 * 86_400_000)
    setTokenReply(() => Response.json({ error: 'refresh_token_expired' }, { status: 401 }))
    expect(await refreshCodexCredential(await refreshDeps(), 'mia')).toBe('revoked')
    expect(await view()).toBe('expired')
    h.advance(10 * 60_000)
    expect((await refreshCodexLeases(await refreshDeps())).due).toBe(0)

    // A permanent failure never revokes a newer login written while the refresh was in flight.
    await signIn(await as('mia'))
    h.advance(8 * 86_400_000)
    setTokenReply(() => Response.json({ error: { code: 'refresh_token_reused' } }, { status: 401 }))
    const racing = await refreshDeps()
    const newerLogin: typeof fetch = async (input, init) => {
      await h.env.SANDBOX_DB.prepare(`UPDATE agent_credentials SET updated_at = updated_at + 5 WHERE agent = 'codex'`).run()
      return racing.fetch!(input, init)
    }
    expect(await refreshCodexCredential({ ...racing, fetch: newerLogin }, 'mia')).toBe('revoked')
    expect(await view()).toBe('active')

    // A new login, then DELETE while a refresh is in flight: the refreshed tokens are dropped.
    await signIn(await as('mia'))
    h.advance(8 * 86_400_000)
    setTokenReply(() => Response.json({ access_token: ACCESS_2, refresh_token: REFRESH_2, id_token: ID }))
    const deps = await refreshDeps()
    const slowFetch: typeof fetch = async (input, init) => {
      await h.call('DELETE', '/v1/agent-credentials/codex', { bearer: await as('mia') })
      return deps.fetch!(input, init)
    }
    expect(await refreshCodexCredential({ ...deps, fetch: slowFetch }, 'mia')).toBe('skipped')
    expect(await view()).toBe('none')
  })
})
