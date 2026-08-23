import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why: opening Settings renders the Bitbucket card, which runs the preflight
// status (getBitbucketAuthStatus) and the card's status IPC
// (getBitbucketConnectionStatus). Neither may decrypt the stored secret, or the
// OS would prompt to unlock the keychain on every Settings open. These tests
// simulate a cold session (files on disk, memory cache empty).

const decryptSpy = vi.fn((value: Buffer) => value.toString('utf-8'))
const OLD_ENV = process.env
const OLD_FETCH = globalThis.fetch
let tempHome = ''

vi.mock('../git/runner', () => ({ gitExecFileAsync: vi.fn() }))

async function loadModules() {
  vi.resetModules()
  const { setSecretStore } = await import('../../shared/secret-store')
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: decryptSpy,
    describeProtectionGap: () => null
  })
  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof Os>('node:os')
    return { ...actual, homedir: () => tempHome }
  })
  // Stub repo detection so the PR fetch reaches the auth-resolution path.
  vi.doMock('./repository-ref', () => ({
    getBitbucketRepoRef: async () => ({ workspace: 'acme', repoSlug: 'app' })
  }))
  const store = await import('./credential-store')
  const client = await import('./client')
  const connection = await import('./credential-connection')
  return { store, client, connection }
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
  tempHome = mkdtempSync(join(tmpdir(), 'orca-bb-nodecrypt-'))
  decryptSpy.mockClear()
})

afterEach(() => {
  process.env = OLD_ENV
  globalThis.fetch = OLD_FETCH
})

const STORED_BASIC_CREDENTIAL = {
  authMode: 'basic',
  email: 'ada@example.com',
  baseUrl: null,
  account: 'ada',
  accessToken: null,
  apiToken: 'secret-token'
} as const

describe('Bitbucket status reads never decrypt the stored secret', () => {
  it('renders connected state from plaintext metadata without touching the keychain', async () => {
    const { store, client, connection } = await loadModules()
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    store.saveBitbucketCredential(STORED_BASIC_CREDENTIAL)

    // Simulate relaunch: secret is on disk but the memory cache is cold, so a
    // decrypt here would surface to the user as a keychain prompt.
    store._resetBitbucketCredentialCache()
    decryptSpy.mockClear()

    const auth = await client.getBitbucketAuthStatus()
    const status = connection.getBitbucketConnectionStatus()

    expect(auth).toEqual({ configured: true, authenticated: true, account: 'ada' })
    expect(status).toMatchObject({ source: 'stored', account: 'ada', authMode: 'basic' })
    expect(decryptSpy).not.toHaveBeenCalled()
    // A stored credential is trusted from metadata rather than revalidated.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('stays cold across repeated status reads, then decrypts once for a real API call', async () => {
    const { store, client, connection } = await loadModules()
    store.saveBitbucketCredential(STORED_BASIC_CREDENTIAL)
    store._resetBitbucketCredentialCache()
    decryptSpy.mockClear()

    for (let i = 0; i < 3; i += 1) {
      await client.getBitbucketAuthStatus()
      connection.getBitbucketConnectionStatus()
    }
    expect(decryptSpy).not.toHaveBeenCalled()

    globalThis.fetch = vi.fn(async () => Response.json({ values: [] })) as unknown as typeof fetch
    await client.getBitbucketPullRequest('/repo', 1, null)
    expect(decryptSpy).toHaveBeenCalledTimes(1)
  })

  it('revalidates a stored credential once its secret is already warm in memory', async () => {
    const { store, client } = await loadModules()
    store.saveBitbucketCredential(STORED_BASIC_CREDENTIAL)
    decryptSpy.mockClear()

    // Saving leaves the secret cached, so status can check /user for free.
    const fetchSpy = vi.fn(async () => new Response(null, { status: 401 }))
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await expect(client.getBitbucketAuthStatus()).resolves.toEqual({
      configured: true,
      authenticated: false,
      account: 'ada'
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(decryptSpy).not.toHaveBeenCalled()
  })
})
