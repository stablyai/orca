import { createCipheriv, createDecipheriv, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto'
import { jwtVerify } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { START_COMMAND } from '../src/sandbox-vm-commands'
import { KMS_RETRY_AFTER_MS } from '../src/secrets'
import { createKeyring } from '../src/secrets-crypto'
import { createKekUnwrapper, kekWrapAad, SecretsKmsError } from '../src/secrets-kms'
import { createHarness } from './harness'

// Fake keys and values only; the log check looks for every one of them.
const K1 = Buffer.alloc(32, 7).toString('base64')
const K2 = Buffer.alloc(32, 9).toString('base64')
const PLAIN = Buffer.alloc(32, 5).toString('base64')
const OP = 'o'.repeat(40)
const KEY_NAME = 'projects/onorca-cloud/locations/us/keyRings/orca-secrets/cryptoKeys/secrets-kek'
const VALUE = 'kms-secret-value-aaaa-1111'
const VALUE_2 = 'kms-secret-value-bbbb-2222'

type FakeKms = ReturnType<typeof createFakeKms>

/**
 * Google's token endpoint and Cloud KMS, in memory. The service-account assertion is verified against the
 * account's public key, and encrypt/decrypt are real AES-256-GCM under a root key that never leaves this object.
 */
function createFakeKms() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const root = randomBytes(32)
  const email = 'orca-secrets@onorca-cloud.iam.gserviceaccount.com'
  const state = {
    tokens: 0,
    decrypts: 0,
    issued: [] as string[],
    /** `down`: 503 from KMS. `denied`: 403 from KMS. `no-account`: token endpoint refuses. `offline`: fetch throws. */
    mode: 'up' as 'up' | 'down' | 'denied' | 'no-account' | 'offline'
  }
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (state.mode === 'offline') {
      throw new TypeError('fetch failed')
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      state.tokens++
      if (state.mode === 'no-account') {
        return Response.json({ error: 'invalid_grant', error_description: 'account disabled' }, { status: 400 })
      }
      const form = new URLSearchParams(String(init?.body))
      expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
      const { payload } = await jwtVerify(form.get('assertion') ?? '', publicKey as unknown as KeyObject, {
        issuer: email,
        audience: 'https://oauth2.googleapis.com/token'
      })
      expect(payload.scope).toBe('https://www.googleapis.com/auth/cloudkms')
      const token = `ya29.fake-${randomBytes(8).toString('hex')}`
      state.issued.push(token)
      return Response.json({ access_token: token, expires_in: 3600, token_type: 'Bearer' })
    }
    if (url === `https://cloudkms.googleapis.com/v1/${KEY_NAME}:decrypt`) {
      state.decrypts++
      if (state.mode === 'down') {
        return Response.json({ error: { code: 503, message: 'backend unavailable' } }, { status: 503 })
      }
      const bearer = new Headers(init?.headers).get('authorization')?.slice('Bearer '.length) ?? ''
      if (state.mode === 'denied' || !state.issued.includes(bearer)) {
        return Response.json({ error: { code: 403, message: 'Permission cloudkms.cryptoKeyVersions.useToDecrypt denied' } }, { status: 403 })
      }
      const body = JSON.parse(String(init?.body)) as { ciphertext: string; additionalAuthenticatedData?: string }
      try {
        const bytes = Buffer.from(body.ciphertext, 'base64')
        const decipher = createDecipheriv('aes-256-gcm', root, bytes.subarray(0, 12))
        decipher.setAAD(Buffer.from(body.additionalAuthenticatedData ?? '', 'base64'))
        decipher.setAuthTag(bytes.subarray(bytes.length - 16))
        const plaintext = Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()])
        return Response.json({ plaintext: plaintext.toString('base64') })
      } catch {
        return Response.json({ error: { code: 400, message: 'Decryption failed: the ciphertext is invalid.' } }, { status: 400 })
      }
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch
  return {
    state,
    fetch: fetcher,
    serviceAccount: JSON.stringify({
      type: 'service_account',
      client_email: email,
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
      // Not trusted by the client: the real endpoint is pinned.
      token_uri: 'https://attacker.example/token'
    }),
    /** What `gcloud kms encrypt` does in the runbook: wrap a KEK's 32 bytes, bound to its id. */
    wrap(kekB64: string, kekId: string): string {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', root, iv)
      cipher.setAAD(Buffer.from(kekWrapAad(kekId)))
      return Buffer.concat([iv, cipher.update(Buffer.from(kekB64, 'base64')), cipher.final(), cipher.getAuthTag()]).toString('base64')
    }
  }
}

let logs: string[] = []
let kms: FakeKms
let clock = 1_800_000_000_000
beforeEach(() => {
  logs = []
  kms = createFakeKms()
  // The keyring cache is per isolate (module state); a fresh fake means fresh wrapped blobs, so no test sees another's entry.
  vi.stubGlobal('fetch', kms.fetch)
  // Past any earlier test's remembered failure.
  clock += 10 * KMS_RETRY_AFTER_MS
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
    })
  }
})
afterEach(() => {
  // No value, key, credential or access token reached a log line.
  const privateKey = (JSON.parse(kms.serviceAccount) as { private_key: string }).private_key
  for (const secret of [VALUE, VALUE_2, K1, K2, PLAIN, privateKey.split('\n')[1]!, ...kms.state.issued]) {
    expect(logs.join('\n')).not.toContain(secret)
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function kmsEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    OPERATOR_TOKEN: OP,
    SECRETS_KEK_SOURCE: 'kms',
    SECRETS_KMS_KEY: KEY_NAME,
    SECRETS_KMS_SERVICE_ACCOUNT: kms.serviceAccount,
    SECRETS_KEK_WRAPPED: kms.wrap(K1, 'k1'),
    ...extra
  }
}

const put = (h: Awaited<ReturnType<typeof createHarness>>, bearer: string, name: string, value: string) =>
  h.call('PUT', `/v1/secrets/personal/${name}`, { bearer, body: { value } })

describe('KMS client', () => {
  it('unwraps a KEK wrapped for its id, with a pinned token endpoint and one token for many calls', async () => {
    const unwrap = createKekUnwrapper({ keyName: KEY_NAME, serviceAccountJson: kms.serviceAccount, fetch: kms.fetch })
    expect(await unwrap(kms.wrap(K1, 'k1'), 'k1')).toBe(K1)
    expect(await unwrap(kms.wrap(K2, 'k2'), 'k2')).toBe(K2)
    expect(kms.state).toMatchObject({ tokens: 1, decrypts: 2 })
    // A blob wrapped for another id, or a corrupted one, does not unwrap.
    await expect(unwrap(kms.wrap(K1, 'k1'), 'k2')).rejects.toMatchObject({ reason: 'invalid', status: 400 })
    await expect(unwrap('AAAA', 'k1')).rejects.toMatchObject({ reason: 'invalid' })
  })

  it('classifies failures and retries only the retryable ones', async () => {
    const unwrap = createKekUnwrapper({ keyName: KEY_NAME, serviceAccountJson: kms.serviceAccount, fetch: kms.fetch })
    const wrapped = kms.wrap(K1, 'k1')
    kms.state.mode = 'down'
    await expect(unwrap(wrapped, 'k1')).rejects.toMatchObject({ name: 'SecretsKmsError', reason: 'unavailable', status: 503 })
    expect(kms.state.decrypts).toBe(2)
    kms.state.mode = 'denied'
    await expect(unwrap(wrapped, 'k1')).rejects.toMatchObject({ reason: 'denied', status: 403 })
    expect(kms.state.decrypts).toBe(3)
    kms.state.mode = 'offline'
    await expect(unwrap(wrapped, 'k1')).rejects.toMatchObject({ reason: 'unavailable' })
    const refused = createKekUnwrapper({ keyName: KEY_NAME, serviceAccountJson: kms.serviceAccount, fetch: kms.fetch })
    kms.state.mode = 'no-account'
    await expect(refused(wrapped, 'k1')).rejects.toMatchObject({ reason: 'denied' })
    // Error text is a fixed code: nothing Google said is carried along.
    const error = await refused(wrapped, 'k1').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SecretsKmsError)
    expect(String(error)).toBe('SecretsKmsError: secrets_kms_denied')
  })

  it('refuses a malformed key name or credential without echoing it', () => {
    for (const keyName of ['', 'projects/x', `${KEY_NAME}/../../other`, `${KEY_NAME}:encrypt`, 'https://evil.example/projects/a/locations/b/keyRings/c/cryptoKeys/d']) {
      expect(() => createKekUnwrapper({ keyName, serviceAccountJson: kms.serviceAccount })).toThrow('secrets_kms_config')
    }
    for (const serviceAccountJson of ['', '{', '{"client_email":"a@b.c"}', 'not-json-PRIVATE']) {
      expect(() => createKekUnwrapper({ keyName: KEY_NAME, serviceAccountJson })).toThrow('secrets_kms_config')
    }
  })
})

describe('secret store with SECRETS_KEK_SOURCE=kms', () => {
  it('is off unless the flag is exactly `kms`: the plaintext SECRETS_KEK path is untouched and KMS is never called', async () => {
    for (const source of [undefined, '', 'KMS', 'env']) {
      const h = await createHarness({ ...kmsEnv(), SECRETS_KEK: PLAIN, ...(source === undefined ? {} : { SECRETS_KEK_SOURCE: source }) })
      if (source === undefined) {
        delete h.env.SECRETS_KEK_SOURCE
      }
      const alice = await h.token('alice')
      expect((await put(h, alice, 'PLAIN_VAR', VALUE)).status).toBe(200)
      const row = h.raw.prepare('SELECT kek_id, wrapped_dek, ciphertext FROM secrets').get() as { kek_id: string; wrapped_dek: string; ciphertext: string }
      const plain = await createKeyring({ id: 'k1', key: PLAIN })
      expect(await plain.open({ scope: 'personal', ownerId: 'user:alice', name: 'PLAIN_VAR' }, { kekId: row.kek_id, wrappedDek: row.wrapped_dek, ciphertext: row.ciphertext })).toBe(VALUE)
    }
    expect(kms.state).toMatchObject({ tokens: 0, decrypts: 0 })
  })

  it('unwraps the KEK once per isolate and seals with it, ignoring any plaintext SECRETS_KEK', async () => {
    const h = await createHarness(kmsEnv({ SECRETS_KEK: PLAIN }))
    const alice = await h.token('alice')
    expect((await put(h, alice, 'FIRST_VAR', VALUE)).status).toBe(200)
    expect((await put(h, alice, 'SECOND_VAR', VALUE_2)).status).toBe(200)
    expect((await h.call('GET', '/v1/secrets?scope=personal', { bearer: alice })).body.secrets).toHaveLength(2)
    expect((await h.call('GET', '/v1/internal/secrets/kek', { bearer: OP })).body).toMatchObject({ activeKekId: 'k1', pending: 0, unknownKekIds: [] })
    // A session start decrypts them too.
    expect((await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: alice })).status).toBe(200)
    expect(h.vercel.commands.find((c) => c.command === START_COMMAND)!.env.ORCA_SECRET_ENV).toBeDefined()
    // One token and one decrypt for all of it; an outage afterwards does not matter to a warm isolate.
    expect(kms.state).toMatchObject({ tokens: 1, decrypts: 1 })
    kms.state.mode = 'down'
    expect((await put(h, alice, 'THIRD_VAR', VALUE)).status).toBe(200)
    expect(kms.state.decrypts).toBe(1)

    // The rows are under the KMS-held key, not the plaintext one that was also configured.
    const row = h.raw.prepare(`SELECT kek_id, wrapped_dek, ciphertext FROM secrets WHERE name = 'FIRST_VAR'`).get() as { kek_id: string; wrapped_dek: string; ciphertext: string }
    const sealed = { kekId: row.kek_id, wrappedDek: row.wrapped_dek, ciphertext: row.ciphertext }
    const binding = { scope: 'personal', ownerId: 'user:alice', name: 'FIRST_VAR' }
    expect(await (await createKeyring({ id: 'k1', key: K1 })).open(binding, sealed)).toBe(VALUE)
    await expect((await createKeyring({ id: 'k1', key: PLAIN })).open(binding, sealed)).rejects.toThrow()
  })

  it.each([
    ['down', 'unavailable'],
    ['denied', 'denied'],
    ['no-account', 'denied'],
    ['offline', 'unavailable']
  ] as const)('answers a clear 503 when KMS is %s, without falling back to the plaintext key', async (mode, reason) => {
    kms.state.mode = mode
    const h = await createHarness(kmsEnv({ SECRETS_KEK: PLAIN }))
    const alice = await h.token('alice')
    const refused = await put(h, alice, 'ANY_VAR', VALUE)
    expect(refused).toEqual({ status: 503, body: { error: 'secrets_unavailable' } })
    expect((await h.send(new Request('https://sandbox.test/v1/secrets?scope=personal', { headers: { authorization: `Bearer ${alice}` } }))).headers.get('retry-after')).toBe('30')
    expect(await h.call('GET', '/v1/internal/secrets/kek', { bearer: OP })).toEqual({ status: 503, body: { error: 'secrets_unavailable', reason } })
    expect(await h.call('POST', '/v1/internal/secrets/rewrap', { bearer: OP, body: {} })).toEqual({ status: 503, body: { error: 'secrets_unavailable', reason } })
    // Nothing was stored under any key.
    expect(h.raw.prepare('SELECT COUNT(*) AS n FROM secrets').get()).toEqual({ n: 0 })
    // A session does not start without its secrets, and no VM is left behind.
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: alice })
    expect(created).toEqual({ status: 503, body: { error: 'secrets_unavailable' } })
    expect(h.vercel.commands.filter((c) => c.command === START_COMMAND)).toHaveLength(0)
    // Routes that need no secrets still answer.
    expect((await h.call('GET', '/v1/internal/status', { bearer: OP })).status).toBe(200)
    expect(logs.some((line) => line.includes('"secrets_kms_unavailable"') && line.includes(`"reason":"${reason}"`))).toBe(true)
  })

  it('remembers a failure briefly instead of calling KMS per request, then recovers', async () => {
    kms.state.mode = 'down'
    const h = await createHarness(kmsEnv())
    const alice = await h.token('alice')
    expect((await put(h, alice, 'ANY_VAR', VALUE)).status).toBe(503)
    const attempts = kms.state.decrypts
    expect((await put(h, alice, 'ANY_VAR', VALUE)).status).toBe(503)
    expect((await h.call('GET', '/v1/secrets?scope=personal', { bearer: alice })).status).toBe(503)
    expect(kms.state.decrypts).toBe(attempts)

    kms.state.mode = 'up'
    clock += KMS_RETRY_AFTER_MS + 1
    expect((await put(h, alice, 'ANY_VAR', VALUE)).status).toBe(200)
    expect((await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: alice })).status).toBe(200)
  })

  it('answers 503 for an incomplete or mislabelled KMS config, never the plaintext key', async () => {
    const cases: Record<string, string>[] = [
      { SECRETS_KMS_KEY: '' },
      { SECRETS_KMS_SERVICE_ACCOUNT: '' },
      { SECRETS_KEK_WRAPPED: '' },
      { SECRETS_KMS_KEY: 'projects/onorca-cloud' },
      { SECRETS_KEK_RETIRED_WRAPPED: '{' },
      // The active blob was wrapped for k1 but is deployed as k2.
      { SECRETS_KEK_ID: 'k2' },
      // KMS hands back something that is not a 32-byte key.
      { SECRETS_KEK_WRAPPED: kms.wrap(Buffer.alloc(16, 1).toString('base64'), 'k1') }
    ]
    for (const broken of cases) {
      const h = await createHarness(kmsEnv({ SECRETS_KEK: PLAIN, ...broken }))
      expect(await put(h, await h.token('alice'), 'ANY_VAR', VALUE)).toEqual({ status: 503, body: { error: 'secrets_unavailable' } })
      expect(h.raw.prepare('SELECT COUNT(*) AS n FROM secrets').get()).toEqual({ n: 0 })
    }
  })

  it('rotates under KMS: new wrapped KEK active, old one retired, sweep, then the retired blob is dropped', async () => {
    const h = await createHarness(kmsEnv())
    const alice = await h.token('alice')
    await put(h, alice, 'FIRST_VAR', VALUE)
    await put(h, alice, 'SECOND_VAR', VALUE_2)

    Object.assign(h.env, {
      SECRETS_KEK_WRAPPED: kms.wrap(K2, 'k2'),
      SECRETS_KEK_ID: 'k2',
      SECRETS_KEK_RETIRED_WRAPPED: JSON.stringify({ k1: h.env.SECRETS_KEK_WRAPPED })
    })
    expect((await h.call('GET', '/v1/internal/secrets/kek', { bearer: OP })).body).toMatchObject({ activeKekId: 'k2', retiredKekIds: ['k1'], pending: 2, retiredInUse: ['k1'], unknownKekIds: [] })
    expect((await h.call('POST', '/v1/internal/secrets/rewrap', { bearer: OP, body: { dryRun: true } })).body).toMatchObject({ scanned: 2, failed: 0 })
    expect((await h.call('POST', '/v1/internal/secrets/rewrap', { bearer: OP, body: {} })).body).toMatchObject({ resealed: 2, pending: 0, done: true })
    expect((await h.call('GET', '/v1/internal/secrets/kek', { bearer: OP })).body).toMatchObject({ pending: 0, retiredDroppable: ['k1'] })

    delete h.env.SECRETS_KEK_RETIRED_WRAPPED
    expect((await h.call('GET', '/v1/internal/secrets/kek', { bearer: OP })).body).toMatchObject({ retiredKekIds: [], pending: 0, unknownKekIds: [] })
    const onlyNew = await createKeyring({ id: 'k2', key: K2 })
    const rows = h.raw.prepare('SELECT name, kek_id, wrapped_dek, ciphertext FROM secrets ORDER BY name').all() as { name: string; kek_id: string; wrapped_dek: string; ciphertext: string }[]
    const opened = await Promise.all(
      rows.map((row) => onlyNew.open({ scope: 'personal', ownerId: 'user:alice', name: row.name }, { kekId: row.kek_id, wrappedDek: row.wrapped_dek, ciphertext: row.ciphertext }))
    )
    expect(opened).toEqual([VALUE, VALUE_2])
  })

  it('moves an existing plaintext-KEK store behind KMS without touching a row', async () => {
    const h = await createHarness({ OPERATOR_TOKEN: OP, SECRETS_KEK: K1 })
    const alice = await h.token('alice')
    await put(h, alice, 'FIRST_VAR', VALUE)
    const before = h.raw.prepare('SELECT * FROM secrets').all()
    // Same KEK, same id, now held by KMS; the Worker secret is removed.
    Object.assign(h.env, kmsEnv())
    delete h.env.SECRETS_KEK
    expect((await h.call('GET', '/v1/internal/secrets/kek', { bearer: OP })).body).toMatchObject({ activeKekId: 'k1', pending: 0, unknownKekIds: [] })
    expect((await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: alice })).status).toBe(200)
    expect(h.vercel.commands.find((c) => c.command === START_COMMAND)!.env.ORCA_SECRET_ENV).toBeDefined()
    expect(h.raw.prepare('SELECT * FROM secrets').all()).toEqual(before)
  })
})
