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

  describe('at-rest protection reporting', () => {
    it('reports no gap when a real keyring backend is selected', () => {
      withPlatform('linux', () => {
        expect(new ElectronSecretStore().describeProtectionGap()).toBeNull()
      })
    })

    it('reports a gap for the Linux basic_text backend, which protects nothing', () => {
      safeStorageMock.getSelectedStorageBackend.mockReturnValue('basic_text')
      withPlatform('linux', () => {
        const gap = new ElectronSecretStore().describeProtectionGap()
        expect(gap).toMatch(/built-in key/)
        expect(gap).toMatch(/gnome-keyring|kwallet/)
      })
    })

    it('keeps sealing AVAILABLE on basic_text so stored credentials still decrypt', () => {
      // Why this matters more than the warning: flipping isEncryptionAvailable() would
      // make decryptWithStatus() stop attempting and return every stored secret as
      // empty. The gap is a trust signal, never a capability switch.
      safeStorageMock.getSelectedStorageBackend.mockReturnValue('basic_text')
      withPlatform('linux', () => {
        const store = new ElectronSecretStore()
        expect(store.isEncryptionAvailable()).toBe(true)
        expect(store.decryptString(store.encryptString('linear-token'))).toBe('linear-token')
      })
    })

    it('does not consult the backend on macOS, where basic_text does not exist', () => {
      withPlatform('darwin', () => {
        expect(new ElectronSecretStore().describeProtectionGap()).toBeNull()
      })
      expect(safeStorageMock.getSelectedStorageBackend).not.toHaveBeenCalled()
    })

    it('does not throw when the Linux-only backend probe is absent', () => {
      // Delete from the live mock because the imported module retains its object reference.
      const probe = safeStorageMock.getSelectedStorageBackend
      // @ts-expect-error deleting a required member is the condition under test
      delete safeStorageMock.getSelectedStorageBackend
      try {
        withPlatform('linux', () => {
          expect(() => new ElectronSecretStore().describeProtectionGap()).not.toThrow()
          expect(new ElectronSecretStore().describeProtectionGap()).toBeNull()
        })
      } finally {
        safeStorageMock.getSelectedStorageBackend = probe
      }
    })

    it('reports no gap when the backend probe throws', () => {
      safeStorageMock.getSelectedStorageBackend.mockImplementation(() => {
        throw new Error('backend unavailable')
      })
      withPlatform('linux', () => {
        expect(new ElectronSecretStore().describeProtectionGap()).toBeNull()
      })
    })

    it('reports no gap for an unknown backend rather than guessing', () => {
      safeStorageMock.getSelectedStorageBackend.mockReturnValue('unknown')
      withPlatform('linux', () => {
        expect(new ElectronSecretStore().describeProtectionGap()).toBeNull()
      })
    })

    it('reports the missing-keyring gap before considering the backend', () => {
      safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
      withPlatform('linux', () => {
        expect(new ElectronSecretStore().describeProtectionGap()).toMatch(/keyring is unavailable/)
      })
    })
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
    expect(new ElectronSecretStore().describeProtectionGap()).toBeNull()
  })

  it('names the missing facility when sealing is unavailable, so the plaintext fallback is explainable', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const reason = new ElectronSecretStore().describeProtectionGap()
    expect(reason).toContain('unencrypted')
    if (process.platform === 'linux') {
      expect(reason).toContain('keyring')
    }
  })
})
