import { beforeEach, describe, expect, it, vi } from 'vitest'

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((plainText: string) => Buffer.from(`os-sealed:${plainText}`)),
  decryptString: vi.fn((cipher: Buffer) => cipher.toString().slice('os-sealed:'.length))
}))

vi.mock('electron', () => ({ safeStorage: safeStorageMock }))

const { ElectronSecretStore } = await import('./electron-secret-store')

describe('ElectronSecretStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
  })

  // Why this shape: the whole safety argument for the SecretStore refactor is that the
  // desktop byte path did not change. That is only true if this adapter forwards
  // verbatim — same argument, same return value, no re-encoding.
  it('forwards encryptString to safeStorage and returns its buffer unchanged', () => {
    const sealed = new ElectronSecretStore().encryptString('token')
    expect(safeStorageMock.encryptString).toHaveBeenCalledExactlyOnceWith('token')
    expect(sealed).toBe(safeStorageMock.encryptString.mock.results[0]!.value)
  })

  it('forwards decryptString to safeStorage and returns its string unchanged', () => {
    const cipher = Buffer.from('os-sealed:token')
    expect(new ElectronSecretStore().decryptString(cipher)).toBe('token')
    expect(safeStorageMock.decryptString).toHaveBeenCalledExactlyOnceWith(cipher)
  })

  // Why the narrower claim: safeStorage is mocked here, so this proves the adapter
  // pairs encrypt/decrypt without mangling the buffer — NOT that credentials sealed by
  // a previous build still open. Real-ciphertext compatibility needs a captured fixture.
  it('pairs encryptString and decryptString without altering the payload', () => {
    const store = new ElectronSecretStore()
    expect(store.decryptString(store.encryptString('linear-token'))).toBe('linear-token')
  })

  it('reports availability from safeStorage rather than caching it', () => {
    const store = new ElectronSecretStore()
    expect(store.isEncryptionAvailable()).toBe(true)
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    expect(store.isEncryptionAvailable()).toBe(false)
  })

  it('has no reason to give while sealing works', () => {
    expect(new ElectronSecretStore().describeUnavailable()).toBeNull()
  })

  it('names the missing facility when sealing is unavailable, so the plaintext fallback is explainable', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const reason = new ElectronSecretStore().describeUnavailable()
    expect(reason).toContain('unencrypted')
    if (process.platform === 'linux') {
      expect(reason).toContain('keyring')
    }
  })
})
