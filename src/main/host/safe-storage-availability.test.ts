import { afterEach, describe, expect, it, vi } from 'vitest'

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(`sealed:${value}`)),
  decryptString: vi.fn((cipher: Buffer) => cipher.toString().replace('sealed:', ''))
}))
vi.mock('electron', () => ({ safeStorage: safeStorageMock }))

const {
  guardedSafeStorage,
  resetSafeStorageWithholdForTests,
  safeStorageWithheldReason,
  withholdSafeStorage
} = await import('./safe-storage-availability')
const { ElectronSecretStore } = await import('./electron-secret-store')

describe('guardedSafeStorage', () => {
  afterEach(() => {
    resetSafeStorageWithholdForTests()
    vi.clearAllMocks()
  })

  it('never reaches the native keychain once withheld', () => {
    withholdSafeStorage('no default keychain')
    withholdSafeStorage('a later reason')

    expect(safeStorageWithheldReason()).toBe('no default keychain')
    expect(guardedSafeStorage.isEncryptionAvailable()).toBe(false)
    expect(() => guardedSafeStorage.encryptString('token')).toThrow('secrets_unavailable')
    expect(() => guardedSafeStorage.decryptString(Buffer.from('x'))).toThrow('secrets_unavailable')
    expect(safeStorageMock.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(safeStorageMock.encryptString).not.toHaveBeenCalled()
  })

  it('makes the secret store report why secrets are unavailable, without probing', () => {
    withholdSafeStorage('this login has no default macOS keychain')
    const store = new ElectronSecretStore()

    expect(store.isEncryptionAvailable()).toBe(false)
    expect(store.describeProtectionGap()).toContain('this login has no default macOS keychain')
    expect(safeStorageMock.isEncryptionAvailable).not.toHaveBeenCalled()
  })
})
