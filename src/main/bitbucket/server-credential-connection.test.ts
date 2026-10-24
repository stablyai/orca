import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const OLD_ENV = process.env
const decryptSpy = vi.fn((value: Buffer) => value.subarray(1).toString('utf-8'))
let tempHome = ''

async function loadModule() {
  vi.resetModules()
  const { setSecretStore } = await import('../../shared/secret-store')
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.concat([Buffer.from([0x00]), Buffer.from(value)]),
    decryptString: decryptSpy,
    describeProtectionGap: () => null
  })
  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof Os>('node:os')
    return { ...actual, homedir: () => tempHome }
  })
  return import('./server-credential-connection')
}

function userResponse(account: string | null, status = 200): Response {
  return new Response(JSON.stringify({ size: 0, values: [] }), {
    status,
    headers: account ? { 'X-AUSERNAME': account } : {}
  })
}

beforeEach(() => {
  process.env = { ...OLD_ENV }
  delete process.env.ORCA_BITBUCKET_SERVER_BASE_URL
  delete process.env.ORCA_BITBUCKET_SERVER_TOKEN
  tempHome = mkdtempSync(join(tmpdir(), 'orca-bitbucket-server-conn-'))
  decryptSpy.mockClear()
})

afterEach(() => {
  process.env = OLD_ENV
  vi.unstubAllGlobals()
})

describe('Bitbucket Server credential connection', () => {
  it('verifies against the users endpoint and stores the account from X-AUSERNAME', async () => {
    const conn = await loadModule()
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => userResponse('alice'))
    vi.stubGlobal('fetch', fetchSpy)

    await expect(
      conn.connectBitbucketServer({ baseUrl: 'https://bitbucket.example.com', accessToken: 't0k' })
    ).resolves.toEqual({ ok: true, account: 'alice' })

    const [url, init] = fetchSpy.mock.calls[0] ?? []
    expect(url).toBe('https://bitbucket.example.com/rest/api/1.0/users?limit=1')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer t0k' })
    expect(conn.getBitbucketServerConnectionStatus()).toEqual({
      configured: true,
      source: 'stored',
      credentialProtection: 'sealed',
      account: 'alice',
      baseUrl: 'https://bitbucket.example.com'
    })
  })

  it('normalizes the base URL before verifying and storing it', async () => {
    const conn = await loadModule()
    const fetchSpy = vi.fn(async (_url: string) => userResponse('alice'))
    vi.stubGlobal('fetch', fetchSpy)

    await conn.connectBitbucketServer({
      baseUrl: ' https://bitbucket.example.com/bitbucket/rest/api/1.0/ ',
      accessToken: 't0k'
    })

    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      'https://bitbucket.example.com/bitbucket/rest/api/1.0/users?limit=1'
    )
    expect(conn.getBitbucketServerConnectionStatus().baseUrl).toBe(
      'https://bitbucket.example.com/bitbucket'
    )
  })

  it('rejects a token the server refuses and stores nothing', async () => {
    const conn = await loadModule()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => userResponse(null, 401))
    )

    await expect(
      conn.connectBitbucketServer({ baseUrl: 'https://bitbucket.example.com', accessToken: 'bad' })
    ).resolves.toEqual({
      ok: false,
      error: 'Bitbucket Server rejected this token. Check the token, then try again.'
    })
    expect(conn.getBitbucketServerConnectionStatus().configured).toBe(false)
  })

  it.each([
    [
      'a network error',
      async () => {
        throw new TypeError('fetch failed')
      }
    ],
    ['a 5xx', async () => userResponse(null, 503)]
  ])('reports unreachable on %s', async (_label, impl) => {
    const conn = await loadModule()
    vi.stubGlobal('fetch', vi.fn(impl))

    await expect(
      conn.connectBitbucketServer({ baseUrl: 'https://bitbucket.example.com', accessToken: 't0k' })
    ).resolves.toEqual({
      ok: false,
      error:
        'Could not reach Bitbucket Server. Check the server URL and your connection, then try again.'
    })
  })

  it.each([
    { baseUrl: '', accessToken: 't0k' },
    { baseUrl: 'https://bitbucket.example.com', accessToken: '  ' },
    { baseUrl: 'ftp://bitbucket.example.com', accessToken: 't0k' }
  ])('requires a server URL and a token: %o', async (input) => {
    const conn = await loadModule()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    await expect(conn.connectBitbucketServer(input)).resolves.toEqual({
      ok: false,
      error: 'Enter the server URL and an access token.'
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reports environment credentials without storing them', async () => {
    process.env.ORCA_BITBUCKET_SERVER_BASE_URL = 'https://bitbucket.example.com/'
    process.env.ORCA_BITBUCKET_SERVER_TOKEN = 'env-token'
    const conn = await loadModule()

    expect(conn.getBitbucketServerConnectionStatus()).toEqual({
      configured: true,
      source: 'environment',
      credentialProtection: null,
      account: null,
      baseUrl: 'https://bitbucket.example.com'
    })
  })

  it('reads status without decrypting the stored secret', async () => {
    const conn = await loadModule()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => userResponse('alice'))
    )
    await conn.connectBitbucketServer({
      baseUrl: 'https://bitbucket.example.com',
      accessToken: 't0k'
    })
    const coldConn = await loadModule()

    expect(coldConn.getBitbucketServerConnectionStatus().account).toBe('alice')
    expect(decryptSpy).not.toHaveBeenCalled()
  })

  it('disconnects without touching the Bitbucket Cloud credential files', async () => {
    const conn = await loadModule()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => userResponse('alice'))
    )
    await conn.connectBitbucketServer({
      baseUrl: 'https://bitbucket.example.com',
      accessToken: 't0k'
    })
    expect(existsSync(join(tempHome, '.orca', 'bitbucket-server-credential.json'))).toBe(true)
    expect(existsSync(join(tempHome, '.orca', 'bitbucket-credential.json'))).toBe(false)

    conn.disconnectBitbucketServer()

    expect(conn.getBitbucketServerConnectionStatus().configured).toBe(false)
    expect(existsSync(join(tempHome, '.orca', 'bitbucket-server-credential.enc'))).toBe(false)
  })
})
