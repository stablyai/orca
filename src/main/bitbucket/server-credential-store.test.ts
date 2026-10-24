import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const OLD_ENV = process.env
let tempHome = ''

async function loadModules() {
  vi.resetModules()
  const { setSecretStore } = await import('../../shared/secret-store')
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.concat([Buffer.from([0x00]), Buffer.from(value)]),
    decryptString: (value) => value.subarray(1).toString('utf-8'),
    describeProtectionGap: () => null
  })
  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof Os>('node:os')
    return { ...actual, homedir: () => tempHome }
  })
  const store = await import('./server-credential-store')
  const config = await import('./server-auth-config')
  return { store, config }
}

beforeEach(() => {
  process.env = { ...OLD_ENV }
  delete process.env.ORCA_BITBUCKET_SERVER_BASE_URL
  delete process.env.ORCA_BITBUCKET_SERVER_TOKEN
  tempHome = mkdtempSync(join(tmpdir(), 'orca-bitbucket-server-store-'))
})

afterEach(() => {
  process.env = OLD_ENV
})

describe('Bitbucket Server credential store', () => {
  it('round-trips a saved credential through resolve', async () => {
    const { store, config } = await loadModules()
    store.saveBitbucketServerCredential({
      baseUrl: 'https://bitbucket.example.com',
      account: 'alice',
      accessToken: 't0k'
    })

    expect(config.getBitbucketServerBaseUrl()).toBe('https://bitbucket.example.com')
    expect(config.hasBitbucketServerCredential()).toBe(true)
    expect(config.resolveBitbucketServerAuthConfig()).toEqual({
      baseUrl: 'https://bitbucket.example.com',
      accessToken: 't0k'
    })
    expect(config.serverAuthHeaders({ baseUrl: null, accessToken: 't0k' })).toEqual({
      Authorization: 'Bearer t0k'
    })
  })

  it('lets environment values win over the stored credential', async () => {
    const { store } = await loadModules()
    store.saveBitbucketServerCredential({
      baseUrl: 'https://stored.example.com',
      account: 'alice',
      accessToken: 'stored'
    })
    process.env.ORCA_BITBUCKET_SERVER_BASE_URL = 'https://env.example.com'
    process.env.ORCA_BITBUCKET_SERVER_TOKEN = 'env'
    const { config } = await loadModules()

    expect(config.getBitbucketServerBaseUrl()).toBe('https://env.example.com')
    expect(config.resolveBitbucketServerAuthConfig()).toEqual({
      baseUrl: 'https://env.example.com',
      accessToken: 'env'
    })
  })

  it('treats hand-edited metadata without a base URL as no credential', async () => {
    mkdirSync(join(tempHome, '.orca'), { recursive: true })
    writeFileSync(
      join(tempHome, '.orca', 'bitbucket-server-credential.json'),
      JSON.stringify({ version: 1, baseUrl: 42, account: 'alice' })
    )
    writeFileSync(join(tempHome, '.orca', 'bitbucket-server-credential.enc'), 'x')
    const { store, config } = await loadModules()

    expect(store.getStoredBitbucketServerMetadata()).toBeNull()
    expect(config.getBitbucketServerBaseUrl()).toBeNull()
    expect(config.hasBitbucketServerCredential()).toBe(false)
  })

  it.each([
    ['https://bitbucket.example.com/', 'https://bitbucket.example.com'],
    ['HTTPS://bitbucket.example.com/bitbucket//', 'https://bitbucket.example.com/bitbucket'],
    ['https://bitbucket.example.com/rest/api/1.0', 'https://bitbucket.example.com'],
    ['bitbucket.example.com', null],
    ['', null],
    [null, null]
  ])('normalizes base URL %s', async (input, expected) => {
    const { config } = await loadModules()
    expect(config.normalizeBitbucketServerBaseUrl(input)).toBe(expected)
  })

  it('refuses the stored token when the plaintext base URL no longer matches the sealed one', async () => {
    const { store } = await loadModules()
    store.saveBitbucketServerCredential({
      baseUrl: 'https://bitbucket.example.com',
      account: 'alice',
      accessToken: 't0k'
    })
    writeFileSync(
      join(tempHome, '.orca', 'bitbucket-server-credential.json'),
      JSON.stringify({ version: 1, baseUrl: 'https://attacker.example.com', account: 'alice' })
    )
    const { config } = await loadModules()

    expect(config.resolveBitbucketServerAuthConfig().accessToken).toBeNull()
  })

  it.each([
    ['only the URL', { ORCA_BITBUCKET_SERVER_BASE_URL: 'https://env.example.com' }],
    ['only the token', { ORCA_BITBUCKET_SERVER_TOKEN: 'env' }]
  ])('ignores a half-set environment pair (%s) and keeps the stored pair', async (_label, env) => {
    const { store } = await loadModules()
    store.saveBitbucketServerCredential({
      baseUrl: 'https://stored.example.com',
      account: 'alice',
      accessToken: 'stored'
    })
    Object.assign(process.env, env)
    const { config } = await loadModules()

    expect(config.getBitbucketServerBaseUrl()).toBe('https://stored.example.com')
    expect(config.resolveBitbucketServerAuthConfig()).toEqual({
      baseUrl: 'https://stored.example.com',
      accessToken: 'stored'
    })
  })
})
