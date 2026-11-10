// Gemini, Cursor and Copilot (BYOK) keys go through the same egress swap as Anthropic/OpenAI keys:
// the VM holds a placeholder, the proxy sends the real key only to that credential's host (and,
// for Cursor, only to the one call that trades it for an access token).
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compileNetworkPolicy } from '../src/network-policy'
import { credentialTargets } from '../src/provider-env'
import { egressSecretHosts, encodeEgressSecretHosts } from '../src/secret-egress'
import { ENV_COMMAND } from '../src/sandbox-vm-commands'
import { createHarness } from './harness'

const KEK = Buffer.alloc(32, 7).toString('base64')
const PROXY_URL = 'https://sandbox.test/v1/egress/proxy'
const GEMINI_KEY = 'AIzaSy-fake-gemini-0000-aaaa-bbbb-cccc'
const CURSOR_KEY = 'key_fake_cursor_1111_dddd_eeee'
const COPILOT_KEY = 'vck_fake_copilot_byok_2222_ffff'
const VALUES = [GEMINI_KEY, CURSOR_KEY, COPILOT_KEY]
const DENY = { response: { statusCode: 403, body: 'orca-egress-denied', contentType: 'text/plain' } }

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
  for (const value of VALUES) {
    expect(logs.join('\n')).not.toContain(value)
  }
  vi.restoreAllMocks()
})

describe('credential routes for Gemini, Cursor and Copilot BYOK', () => {
  it('routes each key to its provider host with the header its client sends', () => {
    const targets = credentialTargets({
      GEMINI_API_KEY: GEMINI_KEY,
      GOOGLE_GENERATIVE_AI_API_KEY: GEMINI_KEY,
      CURSOR_API_KEY: CURSOR_KEY
    })
    expect(targets.map((t) => [t.secret, t.host, Object.keys(t.headers)])).toEqual([
      ['GEMINI_API_KEY', 'generativelanguage.googleapis.com', ['x-goog-api-key']],
      ['GOOGLE_GENERATIVE_AI_API_KEY', 'generativelanguage.googleapis.com', ['x-goog-api-key']],
      ['CURSOR_API_KEY', 'api2.cursor.sh', ['authorization']]
    ])
    const cursor = targets.find((t) => t.secret === 'CURSOR_API_KEY')!
    expect(cursor.paths).toEqual([{ method: 'POST', path: '/auth/exchange_user_api_key' }])
    expect(cursor.allowUnclaimed).toBe(true)
    expect(cursor.keepResponseFields).toEqual(['accessToken'])
  })

  it('routes a Copilot BYOK key only together with its base URL, from the same scope', () => {
    expect(credentialTargets({ COPILOT_PROVIDER_API_KEY: COPILOT_KEY })).toEqual([])
    const env = { COPILOT_PROVIDER_BASE_URL: 'https://ai-gateway.vercel.sh/v1', COPILOT_PROVIDER_API_KEY: COPILOT_KEY }
    expect(credentialTargets(env).map((t) => `${t.secret}@${t.host}`)).toEqual(['COPILOT_PROVIDER_API_KEY@ai-gateway.vercel.sh'])
    // A member's personal base URL never pulls the org's key to the member's host.
    expect(credentialTargets(env, { COPILOT_PROVIDER_BASE_URL: 'user:mia', COPILOT_PROVIDER_API_KEY: 'org:acme' })).toEqual([])
  })

  it('round-trips through the row with the policy taken from code, never from the row', () => {
    const row = {
      egress_secret_hosts: encodeEgressSecretHosts(credentialTargets({ CURSOR_API_KEY: CURSOR_KEY, GEMINI_API_KEY: GEMINI_KEY }))
    }
    expect(row.egress_secret_hosts).toBe('GEMINI_API_KEY@generativelanguage.googleapis.com,CURSOR_API_KEY@api2.cursor.sh')
    const [gemini, cursor] = egressSecretHosts(row)
    expect(gemini).toMatchObject({ secret: 'GEMINI_API_KEY', host: 'generativelanguage.googleapis.com' })
    expect(gemini!.allowUnclaimed).toBeUndefined()
    expect(cursor).toMatchObject({ secret: 'CURSOR_API_KEY', host: 'api2.cursor.sh', allowUnclaimed: true })
    // An unknown name on the row routes nothing.
    expect(egressSecretHosts({ egress_secret_hosts: 'SOMETHING_ELSE@evil.example.com' })).toEqual([])
  })

  it('leaves a host open without the placeholder only when every route on it asks for that', () => {
    const route = (host: string, allowUnclaimed?: boolean) => ({
      host,
      header: 'authorization',
      placeholders: ['Bearer orca-ph-x'],
      via: 'forward' as const,
      forwardURL: PROXY_URL,
      ...(allowUnclaimed ? { allowUnclaimed } : {})
    })
    const policy = compileNetworkPolicy({
      mode: 'allowlist',
      allowlist: ['api2.cursor.sh', 'shared.example.com'],
      credentials: [route('api2.cursor.sh', true), route('shared.example.com', true), { ...route('shared.example.com'), header: 'x-api-key' }]
    })
    expect(policy.allow['api2.cursor.sh']).toEqual([
      { match: { headers: [{ key: { exact: 'authorization' }, value: { exact: 'Bearer orca-ph-x' } }] }, forwardURL: PROXY_URL }
    ])
    expect(policy.allow['shared.example.com']!.at(-1)).toEqual(DENY)
    expect(policy.allow['shared.example.com']!.filter((rule) => 'response' in rule)).toHaveLength(1)
  })
})

describe('egress swap on a sandbox with the new keys', () => {
  async function setup() {
    const { privateKey, publicKey } = await generateKeyPair('RS256')
    const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'v1', alg: 'RS256' }] }
    const upstream: { url: string; method: string; headers: Headers }[] = []
    let reply = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    const h = await createHarness(
      { SECRETS_KEK: KEK, SECRETS_EGRESS_PLACEHOLDERS: 'on', EGRESS_PROXY_URL: PROXY_URL },
      {
        egressKeysForIssuer: () => createLocalJWKSet(jwks),
        credentials: { authorizationFor: async () => null },
        egressFetch: async (input, init) => {
          upstream.push({ url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers) })
          return reply()
        }
      }
    )
    const mia = await h.token('mia', undefined, 'sandbox')
    for (const [name, value] of Object.entries({ GEMINI_API_KEY: GEMINI_KEY, CURSOR_API_KEY: CURSOR_KEY })) {
      expect((await h.call('PUT', `/v1/secrets/personal/${name}`, { body: { value }, bearer: mia })).status).toBe(200)
    }
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    const id: string = created.body.sandbox.id
    const oidc = await new SignJWT({ team_id: 'team_orca', project_id: 'prj_orca', sandbox_name: `orca-test-${id}` })
      .setProtectedHeader({ alg: 'RS256', kid: 'v1' })
      .setIssuer('https://oidc.vercel.com/team_orca')
      .setAudience(PROXY_URL)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    const send = async (host: string, method: string, path: string, headers: Record<string, string>) => {
      const res = await h.send(
        new Request(`${PROXY_URL}${path.split('?')[0]}`, {
          method,
          ...(method === 'GET' ? {} : { body: '{}' }),
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
      return { status: res.status, body: await res.text() }
    }
    return { h, id, send, upstream, setReply: (next: () => Response) => (reply = next) }
  }

  it('the VM sees placeholders; the policy forwards Gemini (fail closed) and Cursor (open for its own tokens)', async () => {
    const { h, id } = await setup()
    const sent = h.vercel.commands.filter((c) => c.command === ENV_COMMAND || c.env.ORCA_SECRET_ENV)
    const all = sent.map((c) => Buffer.from(c.env.ORCA_SECRET_ENV ?? '', 'base64').toString('utf8') + (c.env.ORCA_SECRET_ENV ?? '')).join('\n')
    for (const value of VALUES) {
      expect(all).not.toContain(value)
      expect(all).not.toContain(Buffer.from(value).toString('base64'))
    }
    const policy = [...h.vercel.boxes.values()][0]!.policy
    expect(policy.allow['generativelanguage.googleapis.com']).toEqual([
      { match: { headers: [{ key: { exact: 'x-goog-api-key' }, value: { exact: `orca-ph-gemini-api-key-${id}` } }] }, forwardURL: PROXY_URL },
      DENY
    ])
    expect(policy.allow['api2.cursor.sh']).toEqual([
      { match: { headers: [{ key: { exact: 'authorization' }, value: { exact: `Bearer orca-ph-cursor-api-key-${id}` } }] }, forwardURL: PROXY_URL }
    ])
    expect(policy.allow['*']).toBeUndefined()
  })

  it('Gemini: the real key reaches Google in x-goog-api-key, and the swap is logged by name only', async () => {
    const { id, send, upstream } = await setup()
    const res = await send('generativelanguage.googleapis.com', 'POST', '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse', {
      'x-goog-api-key': `orca-ph-gemini-api-key-${id}`
    })
    expect(res.status).toBe(200)
    expect(upstream.at(-1)!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse')
    expect(upstream.at(-1)!.headers.get('x-goog-api-key')).toBe(GEMINI_KEY)
    expect(logs.some((line) => line.includes('"event":"egress_swap"') && line.includes('"credential":"GEMINI_API_KEY"'))).toBe(true)
  })

  it('Cursor: only the key exchange carries the key, and the refresh token never reaches the VM', async () => {
    const { id, send, upstream, setReply } = await setup()
    setReply(() => new Response(JSON.stringify({ accessToken: 'at-short', refreshToken: 'rt-long-lived' }), { status: 200, headers: { 'content-type': 'application/json', 'content-length': '60' } }))
    const placeholder = `Bearer orca-ph-cursor-api-key-${id}`
    const exchanged = await send('api2.cursor.sh', 'POST', '/auth/exchange_user_api_key', { authorization: placeholder })
    expect(exchanged.status).toBe(200)
    expect(JSON.parse(exchanged.body)).toEqual({ accessToken: 'at-short' })
    expect(upstream.at(-1)!.headers.get('authorization')).toBe(`Bearer ${CURSOR_KEY}`)
    const before = upstream.length
    // Any other call with the placeholder is refused before it leaves the proxy.
    for (const [method, path] of [['GET', '/auth/exchange_user_api_key'], ['POST', '/aiserver.v1.ChatService/StreamChat'], ['POST', '/auth/exchange_user_api_key/../x']]) {
      expect(await send('api2.cursor.sh', method!, path!, { authorization: placeholder })).toEqual({ status: 403, body: 'path_not_allowed' })
    }
    expect(upstream).toHaveLength(before)
  })

  it('Cursor: whatever the reply looks like, nothing but the access token reaches the VM', async () => {
    const { id, send, setReply } = await setup()
    const placeholder = `Bearer orca-ph-cursor-api-key-${id}`
    const replies: [string, string | null, number][] = [
      ['{"accessToken":"at","refreshToken":"rt","nested":{"refreshToken":"rt2"},"refresh_token":"rt3"}', 'text/plain', 200],
      ['{"accessToken":"at","refreshToken":"rt"}', null, 200],
      ['{"accessToken":"at","refreshToken":"rt"}', 'application/problem+json; charset=utf-8', 200],
      ['[{"refreshToken":"rt"}]', 'application/json', 200],
      ['<html>refreshToken rt</html>', 'text/html', 502],
      ['{"error":"invalid key","refreshToken":"rt"}', 'application/json', 401]
    ]
    for (const [body, type, status] of replies) {
      setReply(() => new Response(body, { status, headers: { ...(type ? { 'content-type': type } : {}), 'set-cookie': 'session=rt' } }))
      const res = await send('api2.cursor.sh', 'POST', '/auth/exchange_user_api_key', { authorization: placeholder })
      expect(res.status).toBe(status)
      expect(res.body).not.toContain('rt"')
      expect(res.body).not.toContain('refresh')
      expect(['{"accessToken":"at"}', '{}']).toContain(res.body)
    }
  })

  it('a swappable key with no usable route reaches the VM as a placeholder, never as itself', async () => {
    const { h, id } = await setup()
    const mia = await h.token('mia', undefined, 'sandbox')
    // A Copilot BYOK key without its base URL has no host to be swapped on.
    expect((await h.call('PUT', '/v1/secrets/personal/COPILOT_PROVIDER_API_KEY', { body: { value: COPILOT_KEY }, bearer: mia })).status).toBe(200)
    const last = h.vercel.commands.filter((c) => c.env.ORCA_SECRET_ENV).at(-1)!
    const env = Object.fromEntries(
      last.env.ORCA_SECRET_ENV!.split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), Buffer.from(line.slice(line.indexOf('=') + 1), 'base64').toString('utf8')])
    )
    expect(env.COPILOT_PROVIDER_API_KEY).toBe(`orca-ph-copilot-provider-api-key-${id}`)
    expect(JSON.stringify(env)).not.toContain(COPILOT_KEY)
  })
})
