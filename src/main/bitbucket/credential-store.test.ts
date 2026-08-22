import { existsSync, mkdtempSync, statSync } from 'node:fs'
import type * as Fs from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
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
  // Why: doMock registrations outlive resetModules, so an injected failure from
  // one case would leak into every later one in this file.
  vi.doUnmock('node:fs')
  vi.doMock('electron', () => ({
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: decryptStringMock
    }
  }))
  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof Os>('node:os')
    return { ...actual, homedir: () => tempHome }
  })
  if (options.shortWrites) {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof Fs>('node:fs')
      return {
        ...actual,
        // Why: write(2) may return a short count; publishing without looping
        // would rename a truncated credential into place.
        writeSync: (fd: number, data: Buffer, offset = 0, length = data.length) =>
          actual.writeSync(fd, data, offset, Math.min(1, length))
      }
    })
  }
  if (options.writeError) {
    const error = options.writeError
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof Fs>('node:fs')
      return {
        ...actual,
        writeSync: () => {
          throw error
        }
      }
    })
  }
  if (options.unlinkError) {
    // Why mocked: chmod-based failure injection is not portable — Windows has no
    // POSIX modes and a root/elevated runner can unlink through a 0500 directory.
    const error = options.unlinkError
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof Fs>('node:fs')
      return {
        ...actual,
        unlinkSync: () => {
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
  it('persists plaintext metadata and an encrypted secret, then reads them back', async () => {
    const store = await loadStore()
    store.saveBitbucketCredential({
      authMode: 'basic',
      email: 'ada@example.com',
      baseUrl: null,
      account: 'ada',
      accessToken: null,
      apiToken: 'secret-token'
    })

    expect(store.hasStoredBitbucketCredential()).toBe(true)
    expect(store.getStoredBitbucketMetadata()).toMatchObject({
      authMode: 'basic',
      email: 'ada@example.com',
      account: 'ada'
    })
    expect(store.loadStoredBitbucketSecret()).toMatchObject({
      accessToken: null,
      apiToken: 'secret-token',
      // Why (STA-3941): auth fields live in the envelope so a torn write cannot
      // pair a new secret with a stale email.
      authMode: 'basic',
      email: 'ada@example.com'
    })
  })

  it('writes both credential files 0600', async () => {
    const store = await loadStore()
    store.saveBitbucketCredential({
      authMode: 'token',
      email: null,
      baseUrl: null,
      account: 'dev',
      accessToken: 'access-secret',
      apiToken: null
    })

    for (const file of ['bitbucket-credential.enc', 'bitbucket-credential.json']) {
      expect(statSync(join(tempHome, '.orca', file)).mode & 0o777).toBe(0o600)
    }
  })

  it('re-tightens permissions when overwriting an existing credential', async () => {
    const store = await loadStore()
    const save = (account: string): void =>
      store.saveBitbucketCredential({
        authMode: 'token',
        email: null,
        baseUrl: null,
        account,
        accessToken: 'access-secret',
        apiToken: null
      })
    save('first')
    // Why: writeFileSync's mode is ignored for an existing file, so a loosened
    // credential would stay world-readable across a reconnect.
    const { chmodSync } = await import('node:fs')
    for (const file of ['bitbucket-credential.enc', 'bitbucket-credential.json']) {
      chmodSync(join(tempHome, '.orca', file), 0o644)
    }
    save('second')

    for (const file of ['bitbucket-credential.enc', 'bitbucket-credential.json']) {
      expect(statSync(join(tempHome, '.orca', file)).mode & 0o777).toBe(0o600)
    }
  })

  it('does not decrypt for metadata/status reads — only on a forced secret load', async () => {
    const store = await loadStore()
    store.saveBitbucketCredential({
      authMode: 'token',
      email: null,
      baseUrl: 'https://api.bitbucket.org/2.0',
      account: 'dev',
      accessToken: 'access-secret',
      apiToken: null
    })

    // Simulate a fresh session: caches cleared, files still on disk.
    store._resetBitbucketCredentialCache()

    expect(store.getStoredBitbucketMetadata()?.account).toBe('dev')
    expect(store.hasStoredBitbucketCredential()).toBe(true)
    expect(decryptStringMock).not.toHaveBeenCalled()

    // Without force, the secret stays unread.
    expect(store.loadStoredBitbucketSecret()).toBeNull()
    expect(decryptStringMock).not.toHaveBeenCalled()

    // Forcing the load decrypts exactly once, then caches.
    expect(store.loadStoredBitbucketSecret({ force: true })).toMatchObject({
      accessToken: 'access-secret',
      apiToken: null,
      authMode: 'token'
    })
    expect(decryptStringMock).toHaveBeenCalledTimes(1)
    expect(store.loadStoredBitbucketSecret()).not.toBeNull()
    expect(decryptStringMock).toHaveBeenCalledTimes(1)
  })

  it('rejects non-string fields from hand-edited metadata and secret files', async () => {
    const store = await loadStore()
    const { writeFileSync } = await import('node:fs')
    store.saveBitbucketCredential({
      authMode: 'basic',
      email: 'ada@example.com',
      baseUrl: null,
      account: 'ada',
      accessToken: null,
      apiToken: 'secret-token'
    })

    writeFileSync(
      join(tempHome, '.orca', 'bitbucket-credential.json'),
      JSON.stringify({ version: 1, authMode: 'basic', email: { evil: true }, account: 42 })
    )
    writeFileSync(
      join(tempHome, '.orca', 'bitbucket-credential.enc'),
      JSON.stringify({ accessToken: ['nope'], apiToken: 7 })
    )
    store._resetBitbucketCredentialCache()

    expect(store.getStoredBitbucketMetadata()).toMatchObject({ email: null, account: null })
    expect(store.loadStoredBitbucketSecret({ force: true })).toMatchObject({
      accessToken: null,
      apiToken: null
    })
  })

  it('keeps the previous credential intact when the secret write fails (STA-3941)', async () => {
    const store = await loadStore()
    store.saveBitbucketCredential({
      authMode: 'basic',
      email: 'ada@example.com',
      baseUrl: null,
      account: 'ada',
      accessToken: null,
      apiToken: 'first-token'
    })
    const { readFileSync } = await import('node:fs')
    const before = readFileSync(join(tempHome, '.orca', 'bitbucket-credential.enc'))

    // Why: a direct write truncates in place, so a failure mid-write used to
    // destroy the only working credential. The temp+rename path cannot.
    const failing = await loadStore({ writeError: new Error('disk full') })
    expect(() =>
      failing.saveBitbucketCredential({
        authMode: 'basic',
        email: 'grace@example.com',
        baseUrl: null,
        account: 'grace',
        accessToken: null,
        apiToken: 'second-token'
      })
    ).toThrow(/disk full/)

    expect(readFileSync(join(tempHome, '.orca', 'bitbucket-credential.enc'))).toEqual(before)
    expect(existsSync(join(tempHome, '.orca', 'bitbucket-credential.enc.tmp'))).toBe(false)
  })

  it('authenticates from the envelope when metadata is stale (STA-3941)', async () => {
    const store = await loadStore()
    store.saveBitbucketCredential({
      authMode: 'basic',
      email: 'grace@example.com',
      baseUrl: null,
      account: 'grace',
      accessToken: null,
      apiToken: 'second-token'
    })

    // Simulate an interrupt between publishing the secret and the metadata:
    // metadata still describes the previous connection.
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
    // Auth follows the envelope, so the pair stays usable; only the displayed
    // account is stale until the next status refresh.
    expect(resolveBitbucketAuthConfig()).toMatchObject({
      email: 'grace@example.com',
      apiToken: 'second-token'
    })
  })

  it('still authenticates a credential saved before the envelope carried auth fields', async () => {
    const store = await loadStore()
    store.saveBitbucketCredential({
      authMode: 'basic',
      email: 'ada@example.com',
      baseUrl: null,
      account: 'ada',
      accessToken: null,
      apiToken: 'legacy-token'
    })
    const { writeFileSync } = await import('node:fs')
    // Legacy envelopes held only the two tokens.
    writeFileSync(
      join(tempHome, '.orca', 'bitbucket-credential.enc'),
      JSON.stringify({ accessToken: null, apiToken: 'legacy-token' })
    )
    store._resetBitbucketCredentialCache()

    const { resolveBitbucketAuthConfig } = await import('./resolve-auth')
    expect(resolveBitbucketAuthConfig()).toMatchObject({
      email: 'ada@example.com',
      apiToken: 'legacy-token'
    })
  })

  it('writes the whole credential even when the filesystem short-writes (STA-3941)', async () => {
    const store = await loadStore({ shortWrites: true })
    store.saveBitbucketCredential({
      authMode: 'basic',
      email: 'ada@example.com',
      baseUrl: null,
      account: 'ada',
      accessToken: null,
      apiToken: 'a-token-long-enough-to-need-several-writes'
    })
    store._resetBitbucketCredentialCache()

    expect(store.loadStoredBitbucketSecret({ force: true })).toMatchObject({
      apiToken: 'a-token-long-enough-to-need-several-writes',
      email: 'ada@example.com'
    })
    expect(store.getStoredBitbucketMetadata()?.account).toBe('ada')
  })

  it('clears both files and in-memory state on disconnect', async () => {
    const store = await loadStore()
    store.saveBitbucketCredential({
      authMode: 'basic',
      email: 'ada@example.com',
      baseUrl: null,
      account: 'ada',
      accessToken: null,
      apiToken: 'secret-token'
    })

    store.clearStoredBitbucketCredential()

    expect(store.hasStoredBitbucketCredential()).toBe(false)
    expect(store.getStoredBitbucketMetadata()).toBeNull()
    expect(existsSync(join(tempHome, '.orca', 'bitbucket-credential.enc'))).toBe(false)
    expect(existsSync(join(tempHome, '.orca', 'bitbucket-credential.json'))).toBe(false)
  })

  it('surfaces a non-ENOENT delete failure instead of silently keeping the files', async () => {
    const denied: NodeJS.ErrnoException = Object.assign(new Error('permission denied'), {
      code: 'EACCES'
    })
    const store = await loadStore({ unlinkError: denied })
    store.saveBitbucketCredential({
      authMode: 'basic',
      email: 'ada@example.com',
      baseUrl: null,
      account: 'ada',
      accessToken: null,
      apiToken: 'secret-token'
    })

    // Clearing memory while the files survive would resurrect the credential on
    // the next launch, so the failure has to reach the caller.
    expect(() => store.clearStoredBitbucketCredential()).toThrow(/permission denied/)
    expect(existsSync(join(tempHome, '.orca', 'bitbucket-credential.enc'))).toBe(true)
  })

  it('ignores a missing file on disconnect', async () => {
    const missing: NodeJS.ErrnoException = Object.assign(new Error('no such file'), {
      code: 'ENOENT'
    })
    const store = await loadStore({ unlinkError: missing })
    expect(() => store.clearStoredBitbucketCredential()).not.toThrow()
  })
})
