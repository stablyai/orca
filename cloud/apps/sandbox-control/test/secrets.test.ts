import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createKeyring } from '../src/secrets-crypto'
import { MAX_SECRETS_PER_OWNER, MAX_VALUE_BYTES } from '../src/secrets'
import { START_COMMAND } from '../src/sandbox-vm-commands'
import { createHarness } from './harness'

const KEK = Buffer.alloc(32, 7).toString('base64')
const OLD_KEK = Buffer.alloc(32, 3).toString('base64')
const PROXY_URL = 'https://sandbox.test/v1/egress/proxy'
// Fake values only; the log-redaction check looks for every one of them.
const ORG_KEY = 'sk-ant-api03-ORGSHARED-fake-0000-aaaa'
const PERSONAL_KEY = 'sk-ant-api03-PERSONAL-fake-1111-bbbb'
const OPENAI_KEY = 'sk-proj-fake-openai-2222-cccc'
const ALL_VALUES = [ORG_KEY, PERSONAL_KEY, OPENAI_KEY, 'org-env-value', 'personal-env-value', 'repo-env-value']

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
  // No secret value ever reaches a log line, whatever the test did.
  for (const value of ALL_VALUES) {
    expect(logs.join('\n')).not.toContain(value)
  }
  vi.restoreAllMocks()
})

async function setup(overrides: Record<string, string> = {}, deps: Parameters<typeof createHarness>[1] = {}) {
  const h = await createHarness({ SECRETS_KEK: KEK, ...overrides }, deps)
  const as = async (sub: string, org?: string, role?: string) =>
    h.token(sub, org, 'sandbox', role ? { orgRole: role } : {})
  async function put(scope: string, name: string, value: string, bearer: string, repo?: string) {
    const query = repo ? `?repo=${encodeURIComponent(repo)}` : ''
    return h.call('PUT', `/v1/secrets/${scope}/${name}${query}`, { body: { value }, bearer })
  }
  return { h, as, put }
}

function startEnv(h: Awaited<ReturnType<typeof createHarness>>, index = -1): Record<string, string> {
  const starts = h.vercel.commands.filter((c) => c.command === START_COMMAND)
  const encoded = starts.at(index)!.env.ORCA_SECRET_ENV ?? ''
  return Object.fromEntries(
    encoded
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf('=')
        return [line.slice(0, at), Buffer.from(line.slice(at + 1), 'base64').toString('utf8')]
      })
  )
}

describe('secret envelope encryption', () => {
  const binding = { scope: 'org', ownerId: 'org:acme', name: 'ANTHROPIC_API_KEY' }

  it('round-trips under a per-secret DEK and refuses tampering or a swapped row identity', async () => {
    const keyring = await createKeyring({ id: 'k1', key: KEK })
    const sealed = await keyring.seal(binding, ORG_KEY)
    expect(sealed.ciphertext).not.toContain('ORGSHARED')
    expect(await keyring.open(binding, sealed)).toBe(ORG_KEY)
    // Fresh DEK and IV each time.
    expect((await keyring.seal(binding, ORG_KEY)).wrappedDek).not.toBe(sealed.wrappedDek)

    const flip = (b64: string) => {
      const bytes = Buffer.from(b64, 'base64')
      bytes[bytes.length - 1]! ^= 1
      return bytes.toString('base64')
    }
    await expect(keyring.open(binding, { ...sealed, ciphertext: flip(sealed.ciphertext) })).rejects.toThrow()
    await expect(keyring.open(binding, { ...sealed, wrappedDek: flip(sealed.wrappedDek) })).rejects.toThrow()
    await expect(keyring.open({ ...binding, ownerId: 'org:evil' }, sealed)).rejects.toThrow()
    await expect(keyring.open({ ...binding, name: 'OPENAI_API_KEY' }, sealed)).rejects.toThrow()
    await expect(keyring.open({ ...binding, scope: 'personal' }, sealed)).rejects.toThrow()
  })

  it('opens rows sealed under a retired KEK after rotation, and rejects unknown key ids', async () => {
    const old = await createKeyring({ id: 'k0', key: OLD_KEK })
    const sealed = await old.seal(binding, ORG_KEY)
    const rotated = await createKeyring({ id: 'k1', key: KEK }, { k0: OLD_KEK })
    expect(await rotated.open(binding, sealed)).toBe(ORG_KEY)
    expect((await rotated.seal(binding, ORG_KEY)).kekId).toBe('k1')
    const fresh = await createKeyring({ id: 'k1', key: KEK })
    await expect(fresh.open(binding, sealed)).rejects.toThrow('unknown KEK id')
    await expect(createKeyring({ id: 'k1', key: Buffer.alloc(16).toString('base64') })).rejects.toThrow()
  })
})

describe('secrets API', () => {
  it('stores write-only values: responses and D1 carry metadata and a last-4 hint, never the value', async () => {
    const { h, as, put } = await setup()
    const alice = await as('alice')
    const res = await put('personal', 'ANTHROPIC_API_KEY', PERSONAL_KEY, alice)
    expect(res).toEqual({
      status: 200,
      body: { secret: { scope: 'personal', name: 'ANTHROPIC_API_KEY', kind: 'agent_key', hint: 'bbbb', updatedAt: h.now(), updatedBy: 'alice' } }
    })
    await put('personal', 'SHORT', 'abc', alice)
    const listed = await h.call('GET', '/v1/secrets?scope=personal', { bearer: alice })
    expect(listed.body.secrets.map((s: { name: string; hint: string | null; kind: string }) => [s.name, s.hint, s.kind])).toEqual([
      ['ANTHROPIC_API_KEY', 'bbbb', 'agent_key'],
      ['SHORT', null, 'env']
    ])
    expect(JSON.stringify(listed.body)).not.toContain(PERSONAL_KEY)
    const rows = JSON.stringify(h.raw.prepare('SELECT * FROM secrets').all())
    expect(rows).not.toContain(PERSONAL_KEY)
    expect(rows).not.toContain('PERSONAL-fake')
    // Another user sees none of it.
    expect((await h.call('GET', '/v1/secrets?scope=personal', { as: 'bob' })).body.secrets).toEqual([])
    expect((await h.call('DELETE', '/v1/secrets/personal/SHORT', { as: 'bob' })).status).toBe(404)
    expect((await h.call('DELETE', '/v1/secrets/personal/SHORT', { bearer: alice })).body).toEqual({ deleted: true })
  })

  it('lets only org owners/admins write org secrets; members can list names', async () => {
    const { h, as, put } = await setup()
    const member = await as('mia', 'acme', 'member')
    const noRole = await as('nora', 'acme')
    const admin = await as('ada', 'acme', 'admin')
    const owner = await as('otto', 'acme', 'owner')
    expect(await put('org', 'ANTHROPIC_API_KEY', ORG_KEY, member)).toEqual({
      status: 403,
      body: { error: 'forbidden', reason: 'org_admin_required' }
    })
    expect((await put('org', 'ANTHROPIC_API_KEY', ORG_KEY, noRole)).status).toBe(403)
    expect((await put('org', 'ANTHROPIC_API_KEY', ORG_KEY, admin)).status).toBe(200)
    expect((await put('org', 'FOO', 'org-env-value', owner)).status).toBe(200)
    expect((await h.call('DELETE', '/v1/secrets/org/FOO', { bearer: member })).status).toBe(403)
    const listed = await h.call('GET', '/v1/secrets?scope=org', { bearer: member })
    expect(listed.body.secrets.map((s: { name: string }) => s.name)).toEqual(['ANTHROPIC_API_KEY', 'FOO'])
    // No org on the token: no org scope at all; another org sees nothing of acme's.
    expect((await h.call('GET', '/v1/secrets?scope=org', { as: 'alice' })).body).toEqual({ error: 'forbidden', reason: 'no_org' })
    expect((await h.call('GET', '/v1/secrets?scope=org', { bearer: await as('eve', 'other', 'owner') })).body.secrets).toEqual([])
  })

  it('authorizes repo secrets by the owning account: org admins, or the user for a personal account', async () => {
    const { as, put } = await setup()
    expect((await put('repo', 'FOO', 'repo-env-value', await as('mia', 'acme', 'member'), 'acme/app')).status).toBe(403)
    expect((await put('repo', 'FOO', 'repo-env-value', await as('ada', 'acme', 'admin'), 'acme/app')).status).toBe(200)
    expect((await put('repo', 'FOO', 'repo-env-value', await as('alice'), 'https://github.com/alice/site.git')).body.secret.repo).toBe(
      'github.com/alice/site'
    )
    expect((await put('repo', 'FOO', 'x', await as('alice'))).body).toEqual({ error: 'invalid_request', reason: 'repo_required' })
  })

  it('validates names and refuses subscription credentials', async () => {
    const { h, as, put } = await setup()
    const alice = await as('alice')
    const reason = async (name: string, value = 'value') => (await put('personal', name, value, alice)).body.reason
    expect(await reason('lower_case')).toBe('invalid_name')
    expect(await reason('1ABC')).toBe('invalid_name')
    for (const name of ['PATH', 'HOME', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'ORCA_SANDBOX_ID', 'GH_TOKEN']) {
      expect(await reason(name)).toBe('reserved_name')
    }
    expect(await reason('CLAUDE_CODE_OAUTH_TOKEN', 'x')).toBe('subscription_token_refused')
    expect(await reason('ANTHROPIC_API_KEY', 'sk-ant-oat01-abcdefghijklmnop')).toBe('subscription_token_refused')
    expect(await reason('ANY_NAME', '  sk-ant-oat01-abc')).toBe('subscription_token_refused')
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.c2lnbmF0dXJlLXZhbHVlLWhlcmU'
    expect(await reason('OPENAI_API_KEY', jwt)).toBe('subscription_token_refused')
    expect(await reason('ANTHROPIC_API_KEY', jwt)).toBe('subscription_token_refused')
    expect((await put('personal', 'SOME_SERVICE_JWT', jwt, alice)).status).toBe(200)
    expect((await put('personal', 'AWS_SECRET_ACCESS_KEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', alice)).status).toBe(200)
    expect(await reason('BIG', 'x'.repeat(MAX_VALUE_BYTES + 1))).toBe('value_too_large')
    expect(await reason('EMPTY', '')).toBe('invalid_value')
    for (let i = h.raw.prepare('SELECT COUNT(*) AS n FROM secrets').get()!.n as number; i < MAX_SECRETS_PER_OWNER; i++) {
      await put('personal', `K${i}`, 'v', alice)
    }
    expect((await put('personal', 'ONE_MORE', 'v', alice)).body).toEqual({ error: 'conflict', reason: 'secret_limit' })
    // Overwriting an existing name is still allowed at the cap.
    expect((await put('personal', 'K10', 'v2', alice)).status).toBe(200)
  })

  it('answers 503 until the KEK is configured', async () => {
    const h = await createHarness()
    expect((await h.call('GET', '/v1/secrets?scope=personal')).status).toBe(503)
    expect((await h.call('PUT', '/v1/secrets/personal/FOO', { body: { value: 'x' } })).status).toBe(503)
    expect((await h.call('GET', '/v1/secrets', { bearer: 'nope' })).status).toBe(401)
  })
})

describe('secret injection at session start', () => {
  async function seeded(overrides: Record<string, string> = {}, deps: Parameters<typeof createHarness>[1] = {}) {
    const ctx = await setup(overrides, deps)
    const admin = await ctx.as('ada', 'acme', 'admin')
    const mia = await ctx.as('mia', 'acme', 'member')
    await ctx.put('org', 'ANTHROPIC_API_KEY', ORG_KEY, admin)
    await ctx.put('org', 'FOO', 'org-env-value', admin)
    await ctx.put('org', 'ORG_ONLY', 'o', admin)
    await ctx.put('personal', 'ANTHROPIC_API_KEY', PERSONAL_KEY, mia)
    await ctx.put('personal', 'FOO', 'personal-env-value', mia)
    await ctx.put('personal', 'OPENAI_API_KEY', OPENAI_KEY, mia)
    await ctx.put('repo', 'BAR', 'repo-env-value', admin, 'acme/app')
    await ctx.put('personal', 'BAR', 'personal-bar', mia)
    return { ...ctx, mia, admin }
  }

  it('applies precedence (env: repo > personal > org; agent keys: org > personal) and re-resolves on resume', async () => {
    const { h, mia, put } = await seeded()
    const created = await h.call('POST', '/v1/sandboxes', {
      body: { workspaceId: 'ws-1', machineSize: 'standard', repo: { url: 'https://github.com/acme/app' } },
      bearer: mia
    })
    expect(created.status).toBe(200)
    expect(startEnv(h)).toEqual({
      ANTHROPIC_API_KEY: ORG_KEY,
      BAR: 'repo-env-value',
      FOO: 'personal-env-value',
      OPENAI_API_KEY: OPENAI_KEY,
      ORG_ONLY: 'o'
    })
    // Other start env never carries a value.
    const start = h.vercel.commands.find((c) => c.command === START_COMMAND)!
    expect(JSON.stringify({ ...start.env, ORCA_SECRET_ENV: '' })).not.toContain('fake')

    // Edit, then suspend/resume: the new value lands with no image rebuild.
    await put('personal', 'FOO', 'personal-env-value-2', mia)
    const id = created.body.sandbox.id
    await h.call('POST', `/v1/sandboxes/${id}/suspend`, { bearer: mia })
    await h.call('POST', `/v1/sandboxes/${id}/resume`, { bearer: mia })
    expect(startEnv(h).FOO).toBe('personal-env-value-2')
  })

  it('injects only the sandbox owner’s personal secrets and skips a row whose ciphertext was swapped', async () => {
    const { h, put, as } = await seeded()
    const bob = await as('bob', 'acme', 'member')
    // Copy mia's sealed OPENAI_API_KEY onto bob's personal row: AAD binds it to mia, so it won't open.
    await put('personal', 'OPENAI_API_KEY', 'bob-placeholder-value', bob)
    h.raw.exec(`UPDATE secrets SET (kek_id, wrapped_dek, ciphertext) =
      (SELECT kek_id, wrapped_dek, ciphertext FROM secrets WHERE owner_id = 'user:mia' AND name = 'OPENAI_API_KEY')
      WHERE owner_id = 'user:bob' AND name = 'OPENAI_API_KEY'`)
    expect((await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-b', machineSize: 'standard' }, bearer: bob })).status).toBe(200)
    const env = startEnv(h)
    expect(env).toEqual({ ANTHROPIC_API_KEY: ORG_KEY, FOO: 'org-env-value', ORG_ONLY: 'o' })
    expect(logs.some((line) => line.includes('secret_unreadable') && line.includes('OPENAI_API_KEY'))).toBe(true)
  })

  it('starts without secrets when no KEK is configured', async () => {
    const h = await createHarness()
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' } })
    expect(h.vercel.commands.find((c) => c.command === START_COMMAND)!.env.ORCA_SECRET_ENV).toBeUndefined()
  })
})

describe('model API key egress placeholders (phase 2)', () => {
  async function placeholderSetup() {
    const { privateKey, publicKey } = await generateKeyPair('RS256')
    const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'v1', alg: 'RS256' }] }
    const upstream: { url: string; headers: Headers }[] = []
    const ctx = await setup(
      { SECRETS_EGRESS_PLACEHOLDERS: 'on', EGRESS_PROXY_URL: PROXY_URL },
      {
        egressKeysForIssuer: () => createLocalJWKSet(jwks),
        credentials: { authorizationFor: async () => 'Bearer ghs_fake' },
        egressFetch: async (input, init) => {
          upstream.push({ url: String(input), headers: new Headers(init?.headers) })
          return new Response('data: {"type":"message_stop"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }
      }
    )
    const mia = await ctx.as('mia', 'acme', 'member')
    await ctx.put('org', 'ANTHROPIC_API_KEY', ORG_KEY, await ctx.as('ada', 'acme', 'admin'))
    await ctx.put('personal', 'OPENAI_API_KEY', OPENAI_KEY, mia)
    await ctx.put('personal', 'GEMINI_API_KEY', 'gemini-plain-value', mia)
    const created = await ctx.h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    const sandboxId: string = created.body.sandbox.id
    const oidc = () =>
      new SignJWT({ team_id: 'team_orca', project_id: 'prj_orca', sandbox_name: `orca-test-${sandboxId}` })
        .setProtectedHeader({ alg: 'RS256', kid: 'v1' })
        .setIssuer('https://oidc.vercel.com/team_orca')
        .setAudience(PROXY_URL)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey)
    async function proxied(host: string, headers: Record<string, string>) {
      const response = await ctx.h.send(
        new Request(`${PROXY_URL}/v1/messages`, {
          method: 'POST',
          body: '{"model":"x"}',
          headers: {
            'vercel-forwarded-host': host,
            'vercel-forwarded-scheme': 'https',
            'vercel-forwarded-port': '443',
            'vercel-forwarded-path': '/v1/messages',
            'vercel-sandbox-oidc-token': await oidc(),
            ...headers
          }
        })
      )
      return { status: response.status, body: await response.text() }
    }
    return { ...ctx, sandboxId, proxied, upstream }
  }

  it('gives the VM placeholders, routes only the key hosts, and swaps the real key at egress', async () => {
    const { h, sandboxId, proxied, upstream } = await placeholderSetup()
    const anthropicPh = `orca-ph-anthropic-api-key-${sandboxId}`
    const openaiPh = `orca-ph-openai-api-key-${sandboxId}`
    const geminiPh = `orca-ph-gemini-api-key-${sandboxId}`
    expect(startEnv(h)).toEqual({ ANTHROPIC_API_KEY: anthropicPh, OPENAI_API_KEY: openaiPh, GEMINI_API_KEY: geminiPh })
    const [box] = [...h.vercel.boxes.values()]
    const forward = (header: string, value: string) => ({
      match: { headers: [{ key: { exact: header }, value: { exact: value } }] },
      forwardURL: PROXY_URL
    })
    const deny = { response: { statusCode: 403, body: 'orca-egress-denied', contentType: 'text/plain' } }
    expect(box!.policy.allow['api.anthropic.com']).toEqual([
      forward('x-api-key', anthropicPh),
      forward('authorization', `Bearer ${anthropicPh}`),
      deny
    ])
    expect(box!.policy.allow['api.openai.com']).toEqual([forward('authorization', `Bearer ${openaiPh}`), deny])
    // Gemini keys are swapped too (x-goog-api-key), fail closed like the other model hosts.
    expect(box!.policy.allow['generativelanguage.googleapis.com']).toEqual([forward('x-goog-api-key', geminiPh), deny])

    expect(await proxied('api.anthropic.com', { 'x-api-key': anthropicPh })).toEqual({ status: 200, body: 'data: {"type":"message_stop"}\n\n' })
    expect(upstream.at(-1)!.headers.get('x-api-key')).toBe(ORG_KEY)
    expect((await proxied('api.anthropic.com', { authorization: `Bearer ${anthropicPh}` })).status).toBe(200)
    expect(upstream.at(-1)!.headers.get('authorization')).toBe(`Bearer ${ORG_KEY}`)
    expect((await proxied('api.openai.com', { authorization: `Bearer ${openaiPh}` })).status).toBe(200)
    expect(upstream.at(-1)).toMatchObject({ url: 'https://api.openai.com/v1/messages' })
    expect(upstream.at(-1)!.headers.get('authorization')).toBe(`Bearer ${OPENAI_KEY}`)
    expect(upstream).toHaveLength(3)
  })

  it('denies key-host requests without the placeholder, with another sandbox’s placeholder, or a key it lacks', async () => {
    const { proxied, upstream, sandboxId } = await placeholderSetup()
    expect(await proxied('api.anthropic.com', { 'x-api-key': 'sk-ant-api03-attacker' })).toEqual({ status: 403, body: 'placeholder_missing' })
    expect(await proxied('api.anthropic.com', { authorization: 'Bearer sk-ant-oat01-subscription' })).toEqual({
      status: 403,
      body: 'placeholder_missing'
    })
    expect((await proxied('api.anthropic.com', { 'x-api-key': 'orca-ph-anthropic-api-key-sbx_other' })).status).toBe(403)
    // The openai placeholder is not valid on the anthropic host.
    expect((await proxied('api.anthropic.com', { authorization: `Bearer orca-ph-openai-api-key-${sandboxId}` })).status).toBe(403)
    expect(upstream).toEqual([])
  })

  it('keeps plain env injection and no model routes when the flag is off', async () => {
    const { h, as, put } = await setup({ SECRETS_EGRESS_PLACEHOLDERS: 'off', EGRESS_PROXY_URL: PROXY_URL })
    const mia = await as('mia', 'acme', 'member')
    await put('personal', 'ANTHROPIC_API_KEY', PERSONAL_KEY, mia)
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: mia })
    expect(startEnv(h).ANTHROPIC_API_KEY).toBe(PERSONAL_KEY)
    expect([...h.vercel.boxes.values()][0]!.policy.allow['api.anthropic.com']).toEqual([])
  })
})
