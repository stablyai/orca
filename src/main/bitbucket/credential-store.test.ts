import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
import type * as Fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import type * as WindowsCredentialIo from '../../shared/secure-storage/windows-credential-file-io'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let tempHome = ''
const decryptStringMock = vi.fn((value: Buffer) => value.toString('utf-8'))

async function loadStore(
  options: {
    unlinkError?: NodeJS.ErrnoException
    writeError?: Error
    shortWrites?: boolean
  } = {}
) {
  vi.resetModules()
  // resetModules leaves doMock registrations behind.
  vi.doUnmock('node:fs/promises')
  vi.doUnmock('../../shared/secure-storage/windows-credential-file-io')
  const { setSecretStore } = await import('../../shared/secure-storage/secret-store')
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: decryptStringMock,
    describeProtectionGap: () => null
  })
  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof Os>('node:os')
    return { ...actual, homedir: () => tempHome }
  })
  if (options.writeError) {
    const error = options.writeError
    vi.doMock('../../shared/secure-storage/windows-credential-file-io', async (importOriginal) => ({
      ...(await importOriginal<typeof WindowsCredentialIo>()),
      createWindowsCredentialStage: async () => {
        throw error
      }
    }))
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof Fs>('node:fs/promises')
      return {
        ...actual,
        open: async () => {
          throw error
        }
      }
    })
  }
  if (options.unlinkError) {
    // Mock failures: POSIX modes cannot reliably deny deletion on Windows or elevated runners.
    const error = options.unlinkError
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof Fs>('node:fs/promises')
      return {
        ...actual,
        unlink: async () => {
          throw error
        }
      }
    })
  }
  return import('./credential-store')
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'orca-bitbucket-store-'))
  decryptStringMock.mockClear()
})

describe('Bitbucket credential store', () => {
  it('re-tightens permissions when overwriting an existing credential', async () => {
    const store = await loadStore()
    const save = async (account: string): Promise<void> =>
      await store.saveBitbucketCredential({
        authMode: 'token',
        email: null,
        baseUrl: null,
        account,
        accessToken: 'access-secret',
        apiToken: null
      })
    await save('first')
    const { chmodSync } = await import('node:fs')
    for (const file of ['bitbucket-credential.enc', 'bitbucket-credential.json']) {
      chmodSync(join(tempHome, '.orca', file), 0o644)
    }
    await save('second')

    for (const file of ['bitbucket-credential.enc', 'bitbucket-credential.json']) {
      expect(statSync(join(tempHome, '.orca', file)).mode & 0o777).toBe(0o600)
    }
  })

  it('keeps the previous credential intact when the secret write fails (STA-3941)', async () => {
    const store = await loadStore()
    await store.saveBitbucketCredential({
      authMode: 'basic',
      email: 'ada@example.com',
      baseUrl: null,
      account: 'ada',
      accessToken: null,
      apiToken: 'first-token'
    })
    const { readFileSync } = await import('node:fs')

    const failing = await loadStore({ writeError: new Error('disk full') })
    await expect(
      failing.saveBitbucketCredential({
        authMode: 'basic',
        email: 'grace@example.com',
        baseUrl: null,
        account: 'grace',
        accessToken: null,
        apiToken: 'second-token'
      })
    ).rejects.toThrow(/disk full/)

    expect(
      JSON.parse(readFileSync(join(tempHome, '.orca', 'bitbucket-credential.enc'), 'utf8'))
    ).toEqual({
      accessToken: null,
      apiToken: 'first-token',
      authMode: 'basic',
      email: 'ada@example.com',
      baseUrl: null
    })
    expect(readdirSync(join(tempHome, '.orca')).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('authenticates from the envelope when metadata is stale (STA-3941)', async () => {
    const store = await loadStore()
    await store.saveBitbucketCredential({
      authMode: 'basic',
      email: 'grace@example.com',
      baseUrl: null,
      account: 'grace',
      accessToken: null,
      apiToken: 'second-token'
    })

    // Simulate interruption after secret publication but before metadata publication.
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      join(tempHome, '.orca', 'bitbucket-credential.json'),
      JSON.stringify({
        version: 1,
        authMode: 'basic',
        email: 'ada@example.com',
        baseUrl: null,
        account: 'ada',
        updatedAt: ''
      })
    )
    store._resetBitbucketCredentialCache()

    const { resolveBitbucketAuthConfig } = await import('./resolve-auth')
    expect(await resolveBitbucketAuthConfig()).toMatchObject({
      email: 'grace@example.com',
      apiToken: 'second-token'
    })
  })

  it('still authenticates a credential saved before the envelope carried auth fields', async () => {
    const store = await loadStore()
    await store.saveBitbucketCredential({
      authMode: 'basic',
      email: 'ada@example.com',
      baseUrl: null,
      account: 'ada',
      accessToken: null,
      apiToken: 'legacy-token'
    })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      join(tempHome, '.orca', 'bitbucket-credential.enc'),
      JSON.stringify({ accessToken: null, apiToken: 'legacy-token' })
    )
    store._resetBitbucketCredentialCache()

    const { resolveBitbucketAuthConfig } = await import('./resolve-auth')
    expect(await resolveBitbucketAuthConfig()).toMatchObject({
      email: 'ada@example.com',
      apiToken: 'legacy-token'
    })
  })

  it('keeps legacy authentication on one account while a replacement save is queued', async () => {
    const store = await loadStore()
    await store.saveBitbucketCredential({
      authMode: 'basic',
      email: 'ada@example.com',
      baseUrl: 'https://first.example.com',
      account: 'ada',
      accessToken: null,
      apiToken: 'legacy-token'
    })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(store.getSecretPath(), JSON.stringify({ apiToken: 'legacy-token' }))
    store._resetBitbucketCredentialCache()
    const { resolveBitbucketAuthConfig } = await import('./resolve-auth')
    const resolving = resolveBitbucketAuthConfig()
    const saving = store.saveBitbucketCredential({
      authMode: 'basic',
      email: 'grace@example.com',
      baseUrl: 'https://second.example.com',
      account: 'grace',
      accessToken: null,
      apiToken: 'new-token'
    })
    try {
      expect(await resolving).toEqual({
        baseUrl: 'https://first.example.com',
        accessToken: null,
        email: 'ada@example.com',
        apiToken: 'legacy-token'
      })
    } finally {
      await saving
    }
  })

  it('clears both files and in-memory state on disconnect', async () => {
    const store = await loadStore()
    await store.saveBitbucketCredential({
      authMode: 'basic',
      email: 'ada@example.com',
      baseUrl: null,
      account: 'ada',
      accessToken: null,
      apiToken: 'secret-token'
    })

    await store.clearStoredBitbucketCredential()

    expect(await store.hasStoredBitbucketCredential()).toBe(false)
    expect(await store.getStoredBitbucketMetadata()).toBeNull()
    expect(existsSync(join(tempHome, '.orca', 'bitbucket-credential.enc'))).toBe(false)
    expect(existsSync(join(tempHome, '.orca', 'bitbucket-credential.json'))).toBe(false)
  })

  it('surfaces a non-ENOENT delete failure instead of silently keeping the files', async () => {
    const denied: NodeJS.ErrnoException = Object.assign(new Error('permission denied'), {
      code: 'EACCES'
    })
    const store = await loadStore({ unlinkError: denied })
    await store.saveBitbucketCredential({
      authMode: 'basic',
      email: 'ada@example.com',
      baseUrl: null,
      account: 'ada',
      accessToken: null,
      apiToken: 'secret-token'
    })

    await expect(store.clearStoredBitbucketCredential()).rejects.toThrow(/permission denied/)
    expect(existsSync(join(tempHome, '.orca', 'bitbucket-credential.enc'))).toBe(true)
  })
})
