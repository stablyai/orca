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
})
