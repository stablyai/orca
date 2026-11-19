import { beforeEach, describe, expect, it, vi } from 'vitest'

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((plainText: string) => Buffer.from(`os-sealed:${plainText}`)),
  decryptString: vi.fn((cipher: Buffer) => cipher.toString().slice('os-sealed:'.length)),
  getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret')
}))

const hasSwitch = vi.hoisted(() => vi.fn(() => false))

vi.mock('electron', () => ({
  app: { commandLine: { hasSwitch } },
  safeStorage: safeStorageMock
}))

const { ElectronSecretStore } = await import('./electron-secret-store')

describe('ElectronSecretStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hasSwitch.mockReturnValue(false)
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    safeStorageMock.getSelectedStorageBackend.mockReturnValue('gnome_libsecret')
  })

  function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
    const original = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
    try {
      return run()
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: original })
    }
  }

  it('keeps mock-keychain encryption usable but reports credentials as unprotected', () => {
    hasSwitch.mockReturnValue(true)
    withPlatform('darwin', () => {
      const store = new ElectronSecretStore()
      expect(store.isEncryptionAvailable()).toBe(true)
      expect(store.describeSealing()).toMatchObject({ kind: 'none' })
      expect(store.describeProtectionGap()).toContain('ORCA_DEV_USE_KEYCHAIN=1')
    })
  })

  it('rejects credentials from another keychain mode before decryption', () => {
    withPlatform('darwin', () => {
      const store = new ElectronSecretStore()
      const realCipher = store.encryptString('existing credential')
      hasSwitch.mockReturnValue(true)
      expect(() => store.decryptString(realCipher)).toThrow('different keychain mode')
      const mockCipher = store.encryptString('test credential')
      expect(store.decryptString(mockCipher)).toBe('test credential')
      hasSwitch.mockReturnValue(false)
      expect(() => store.decryptString(mockCipher)).toThrow('different keychain mode')
      expect(store.decryptString(realCipher)).toBe('existing credential')
    })
  })

  it('reports basic_text, a withheld keychain and an unavailable keychain as unsealed', () => {
    safeStorageMock.getSelectedStorageBackend.mockReturnValue('basic_text')
    withPlatform('linux', () => {
      expect(new ElectronSecretStore().describeSealing()).toMatchObject({ kind: 'none' })
    })
    safeStorageMock.getSelectedStorageBackend.mockReturnValue('gnome_libsecret')
    withPlatform('linux', () => {
      expect(new ElectronSecretStore().describeSealing()).toEqual({ kind: 'os-keychain' })
    })
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    withPlatform('darwin', () => {
      expect(new ElectronSecretStore().describeSealing()).toMatchObject({ kind: 'none' })
    })
  })
})
