import { describe, expect, it, vi, beforeEach } from 'vitest'

// Why: passphrase-dialog imports `electron` at module top — mocked here so
// select-backend can be imported under vitest's node environment.
vi.mock('./passphrase-dialog', () => ({
  showPassphrasePrompt: vi.fn(async () => null)
}))

import { selectSecretsBackend, _resetSelectionCacheForTest } from './select-backend'

const probeKeychainMock = vi.fn<() => Promise<boolean>>()
vi.mock('./keychain-backend', () => ({
  createKeychainBackend: () => ({
    backendId: 'keychain',
    read: vi.fn(),
    write: vi.fn(),
    delete: vi.fn()
  }),
  probeKeychainAvailable: () => probeKeychainMock()
}))

const efbDepsMock = vi.fn()
vi.mock('./encrypted-file-backend', () => ({
  createEncryptedFileBackend: (deps: unknown) => {
    efbDepsMock(deps)
    return { backendId: 'encrypted-file', read: vi.fn(), write: vi.fn(), delete: vi.fn() }
  }
}))

beforeEach(() => {
  probeKeychainMock.mockReset()
  efbDepsMock.mockReset()
  _resetSelectionCacheForTest()
  delete process.env.ORCA_FORCE_ENCRYPTED_SECRETS
})

describe('selectSecretsBackend', () => {
  it('returns keychain backend on macOS when probe succeeds', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    probeKeychainMock.mockResolvedValueOnce(true)
    const backend = await selectSecretsBackend({ userDataDir: '/tmp/u' })
    expect(backend.backendId).toBe('keychain')
  })

  it('returns encrypted-file backend on linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const backend = await selectSecretsBackend({ userDataDir: '/tmp/u' })
    expect(backend.backendId).toBe('encrypted-file')
    expect(probeKeychainMock).not.toHaveBeenCalled()
  })

  it('returns encrypted-file backend on win32', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const backend = await selectSecretsBackend({ userDataDir: '/tmp/u' })
    expect(backend.backendId).toBe('encrypted-file')
  })

  it('falls back to encrypted-file when keychain probe fails on darwin', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    probeKeychainMock.mockResolvedValueOnce(false)
    const backend = await selectSecretsBackend({ userDataDir: '/tmp/u' })
    expect(backend.backendId).toBe('encrypted-file')
  })

  it('respects ORCA_FORCE_ENCRYPTED_SECRETS=1 regardless of platform', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    process.env.ORCA_FORCE_ENCRYPTED_SECRETS = '1'
    const backend = await selectSecretsBackend({ userDataDir: '/tmp/u' })
    expect(backend.backendId).toBe('encrypted-file')
    expect(probeKeychainMock).not.toHaveBeenCalled()
  })

  it('caches selection per process', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    probeKeychainMock.mockResolvedValueOnce(true)
    const a = await selectSecretsBackend({ userDataDir: '/tmp/u' })
    const b = await selectSecretsBackend({ userDataDir: '/tmp/u' })
    expect(a).toBe(b)
    expect(probeKeychainMock).toHaveBeenCalledTimes(1)
  })
})
