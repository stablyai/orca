import { beforeEach, describe, expect, it, vi } from 'vitest'

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((plainText: string) => Buffer.from(`os-sealed:${plainText}`)),
  decryptString: vi.fn((cipher: Buffer) => cipher.toString().slice('os-sealed:'.length)),
  getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret')
}))

vi.mock('electron', () => ({ safeStorage: safeStorageMock }))

const { ElectronSecretStore } = await import('./electron-secret-store')

describe('ElectronSecretStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
