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
  const { setSecretStore } = await import('../../shared/secret-store')
  setSecretStore({
    isEncryptionAvailable: () => true,
    // A binary prefix lets the protection reporter distinguish sealed data from plaintext.
    encryptString: (value) => Buffer.concat([Buffer.from([0x00]), Buffer.from(value)]),
    decryptString: (value) => value.subarray(1).toString('utf-8'),
    describeProtectionGap: () => null
  })
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

  it('saves an access token Bitbucket accepts without account access (STA-14576)', async () => {
    const conn = await loadModule()
    globalThis.fetch = vi.fn<typeof fetch>(
      async () => new Response('<html>Forbidden</html>', { status: 403 })
    )
    const proxied = await conn.connectBitbucket({ authMode: 'token', accessToken: 'repo-token' })
    expect(proxied.ok).toBe(false)
    expect(conn.getBitbucketConnectionStatus().source).toBe('none')

    // Bitbucket's /user answer for every repository, project or workspace access token.
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          type: 'error',
          error: { message: 'Token is invalid or not supported for this endpoint.' }
        },
        { status: 403 }
      )
    )
    const result = await conn.connectBitbucket({ authMode: 'token', accessToken: 'repo-token' })
    expect(result).toEqual({ ok: true, account: null })
    expect(conn.getBitbucketConnectionStatus().source).toBe('stored')
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
})
