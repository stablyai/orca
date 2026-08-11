import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const OLD_ENV = process.env
const OLD_FETCH = globalThis.fetch
let tempHome = ''

async function loadModule() {
  vi.resetModules()
  vi.doMock('electron', () => ({
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString('utf-8')
    }
  }))
  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof Os>('node:os')
    return { ...actual, homedir: () => tempHome }
  })
  return import('./credential-connection')
}

beforeEach(() => {
  process.env = { ...OLD_ENV }
  for (const key of [
    'ORCA_BITBUCKET_ACCESS_TOKEN',
    'ORCA_BITBUCKET_EMAIL',
    'ORCA_BITBUCKET_API_TOKEN',
    'ORCA_BITBUCKET_API_BASE_URL'
  ]) {
    delete process.env[key]
  }
  tempHome = mkdtempSync(join(tmpdir(), 'orca-bitbucket-conn-'))
})

afterEach(() => {
  process.env = OLD_ENV
  globalThis.fetch = OLD_FETCH
})

describe('Bitbucket credential connection', () => {
  it('verifies credentials before saving and reports a stored connection', async () => {
    const conn = await loadModule()
    globalThis.fetch = vi.fn(async () =>
      Response.json({ username: 'ada' })
    ) as unknown as typeof fetch

    await expect(
      conn.connectBitbucket({
        authMode: 'basic',
        email: 'ada@example.com',
        apiToken: 'tok'
      })
    ).resolves.toEqual({ ok: true, account: 'ada' })

    expect(conn.getBitbucketConnectionStatus()).toEqual({
      configured: true,
      source: 'stored',
      account: 'ada',
      authMode: 'basic',
      email: 'ada@example.com',
      baseUrl: null
    })
  })

  it('sends Basic auth built from the entered email and API token', async () => {
    const conn = await loadModule()
    const fetchSpy = vi.fn(async () => Response.json({ username: 'ada' }))
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await conn.connectBitbucket({ authMode: 'basic', email: 'ada@example.com', apiToken: 'tok' })

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.bitbucket.org/2.0/user')
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('ada@example.com:tok').toString('base64')}`
    )
  })

  it('rejects credentials that fail the /user check without saving them', async () => {
    const conn = await loadModule()
    globalThis.fetch = vi.fn(
      async () => new Response(null, { status: 401 })
    ) as unknown as typeof fetch

    const result = await conn.connectBitbucket({
      authMode: 'token',
      accessToken: 'bad'
    })
    expect(result.ok).toBe(false)
    expect(conn.getBitbucketConnectionStatus().source).toBe('none')
  })

  it('separates a rejected credential from an unreachable host (STA-3944)', async () => {
    const conn = await loadModule()

    globalThis.fetch = vi.fn(
      async () => new Response(null, { status: 401 })
    ) as unknown as typeof fetch
    const rejected = await conn.connectBitbucket({ authMode: 'token', accessToken: 'bad' })
    expect(!rejected.ok && rejected.error).toMatch(/rejected these credentials/i)

    // Why: a timeout or 5xx says nothing about the token; calling it invalid
    // sends the user off to regenerate a credential that still works.
    for (const failure of [
      async () => {
        throw new Error('network down')
      },
      async () => new Response(null, { status: 503 })
    ]) {
      globalThis.fetch = vi.fn(failure) as unknown as typeof fetch
      const unreachable = await conn.connectBitbucket({ authMode: 'token', accessToken: 'good' })
      expect(!unreachable.ok && unreachable.error).toMatch(/could not reach bitbucket/i)
    }
    expect(conn.getBitbucketConnectionStatus().source).toBe('none')
  })

  it('rejects an incomplete basic-auth credential before making a request', async () => {
    const conn = await loadModule()
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const result = await conn.connectBitbucket({
      authMode: 'basic',
      email: 'ada@example.com'
    })
    expect(result.ok).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reports environment variables as the source and takes precedence over stored creds', async () => {
    const conn = await loadModule()
    globalThis.fetch = vi.fn(async () =>
      Response.json({ username: 'ada' })
    ) as unknown as typeof fetch
    await conn.connectBitbucket({
      authMode: 'basic',
      email: 'ada@example.com',
      apiToken: 'tok'
    })

    process.env.ORCA_BITBUCKET_ACCESS_TOKEN = 'env-token'
    expect(conn.getBitbucketConnectionStatus()).toMatchObject({
      configured: true,
      source: 'environment',
      authMode: 'token'
    })
  })

  it('lets an env API base URL override the stored one without env credentials', async () => {
    const conn = await loadModule()
    globalThis.fetch = vi.fn(async () =>
      Response.json({ username: 'ada' })
    ) as unknown as typeof fetch
    await conn.connectBitbucket({
      authMode: 'basic',
      email: 'ada@example.com',
      apiToken: 'tok',
      baseUrl: 'https://stored.example.com/2.0'
    })

    // Only the base URL is in the env, so `hasAuth(env)` is false — precedence
    // is per-setting, not all-or-nothing.
    process.env.ORCA_BITBUCKET_API_BASE_URL = 'https://env.example.com/2.0'
    const { resolveBitbucketAuthConfig } = await import('./resolve-auth')
    expect(resolveBitbucketAuthConfig().baseUrl).toBe('https://env.example.com/2.0')
  })

  it('clears the stored connection on disconnect', async () => {
    const conn = await loadModule()
    globalThis.fetch = vi.fn(async () =>
      Response.json({ username: 'ada' })
    ) as unknown as typeof fetch
    await conn.connectBitbucket({
      authMode: 'basic',
      email: 'ada@example.com',
      apiToken: 'tok'
    })

    conn.disconnectBitbucket()
    expect(conn.getBitbucketConnectionStatus().source).toBe('none')
  })
})
