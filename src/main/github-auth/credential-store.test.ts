import { existsSync, mkdtempSync, statSync } from 'node:fs'
import type * as Os from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let tempHome = ''
const decryptStringMock = vi.fn((value: Buffer) => value.toString('utf-8'))

async function loadStore() {
  vi.resetModules()
  vi.doUnmock('node:fs')
  const { setSecretStore } = await import('../../shared/secret-store')
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
  return import('./credential-store')
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'orca-github-store-'))
  decryptStringMock.mockClear()
})

describe('GitHub credential store', () => {
  it('persists plaintext metadata and an encrypted secret, then reads them back', async () => {
    const store = await loadStore()
    store.saveGitHubCredential({
      token: 'secret-token',
      authMethod: 'device-flow',
      login: 'octocat',
      name: 'The Octocat',
      avatarUrl: 'https://avatars.githubusercontent.com/u/1'
    })

    expect(store.hasStoredGitHubCredential()).toBe(true)
    expect(store.getStoredGitHubMetadata()).toMatchObject({
      authMethod: 'device-flow',
      login: 'octocat',
      avatarUrl: 'https://avatars.githubusercontent.com/u/1'
    })
    expect(store.loadStoredGitHubSecret()).toMatchObject({
      token: 'secret-token',
      authMethod: 'device-flow'
    })
  })

  // Why skipIf: Windows has no POSIX modes — chmod there is a documented no-op
  // (see restrictCredentialFileToOwner), so the 0600 assertion is POSIX-only.
  it.skipIf(process.platform === 'win32')('writes both credential files 0600', async () => {
    const store = await loadStore()
    store.saveGitHubCredential({
      token: 'secret-token',
      authMethod: 'pat',
      login: 'octocat',
      name: null,
      avatarUrl: null
    })

    for (const file of ['github-credential.enc', 'github-credential.json']) {
      expect(statSync(join(tempHome, '.orca', file)).mode & 0o777).toBe(0o600)
    }
  })

  it('does not decrypt for metadata/status reads — only on a forced secret load', async () => {
    const store = await loadStore()
    store.saveGitHubCredential({
      token: 'secret-token',
      authMethod: 'pat',
      login: 'octocat',
      name: null,
      avatarUrl: null
    })

    // Simulate a fresh session: caches cleared, files still on disk.
    store._resetGitHubCredentialCache()

    expect(store.getStoredGitHubMetadata()?.login).toBe('octocat')
    expect(store.hasStoredGitHubCredential()).toBe(true)
    expect(decryptStringMock).not.toHaveBeenCalled()

    // Without force, the secret stays unread.
    expect(store.loadStoredGitHubSecret()).toBeNull()
    expect(decryptStringMock).not.toHaveBeenCalled()

    // Forcing the load decrypts exactly once, then caches.
    expect(store.loadStoredGitHubSecret({ force: true })).toMatchObject({ token: 'secret-token' })
    expect(decryptStringMock).toHaveBeenCalledTimes(1)
    expect(store.loadStoredGitHubSecret()).not.toBeNull()
    expect(decryptStringMock).toHaveBeenCalledTimes(1)
  })

  it('rejects hand-edited metadata with an unknown auth method', async () => {
    const store = await loadStore()
    store.saveGitHubCredential({
      token: 'secret-token',
      authMethod: 'pat',
      login: 'octocat',
      name: null,
      avatarUrl: null
    })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      join(tempHome, '.orca', 'github-credential.json'),
      JSON.stringify({ version: 1, authMethod: 'oauth-app', login: 'octocat' })
    )
    store._resetGitHubCredentialCache()

    expect(store.getStoredGitHubMetadata()).toBeNull()
    expect(store.hasStoredGitHubCredential()).toBe(false)
  })

  it('clears both files and in-memory state on disconnect', async () => {
    const store = await loadStore()
    store.saveGitHubCredential({
      token: 'secret-token',
      authMethod: 'pat',
      login: 'octocat',
      name: null,
      avatarUrl: null
    })

    store.clearStoredGitHubCredential()

    expect(store.hasStoredGitHubCredential()).toBe(false)
    expect(store.getStoredGitHubMetadata()).toBeNull()
    expect(existsSync(join(tempHome, '.orca', 'github-credential.enc'))).toBe(false)
    expect(existsSync(join(tempHome, '.orca', 'github-credential.json'))).toBe(false)
  })
})
