import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import {
  getDbEncryptionStatus,
  encryptDbSecret,
  decryptDbSecret,
  ensureDbSecretAtRest,
  isDbSecretAtRest
} from './db-credential-store'

// Mock electron safeStorage and control platform
const { isEncryptionAvailableMock, encryptStringMock, decryptStringMock, getSelectedStorageBackendMock } =
  vi.hoisted(() => ({
    isEncryptionAvailableMock: vi.fn(() => true),
    encryptStringMock: vi.fn((plaintext: string) =>
      Buffer.from(`mock-encrypted:${plaintext}`, 'utf-8')
    ),
    decryptStringMock: vi.fn((ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('mock-encrypted:')) {
        throw new Error('decryption_failed')
      }
      return decoded.slice('mock-encrypted:'.length)
    }),
    getSelectedStorageBackendMock: vi.fn(() => 'gnome_libsecret')
  }))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: isEncryptionAvailableMock,
    encryptString: encryptStringMock,
    decryptString: decryptStringMock,
    getSelectedStorageBackend: getSelectedStorageBackendMock
  }
}))

describe('db-credential-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isEncryptionAvailableMock.mockReturnValue(true)
    encryptStringMock.mockImplementation((plaintext: string) =>
      Buffer.from(`mock-encrypted:${plaintext}`, 'utf-8')
    )
    decryptStringMock.mockImplementation((ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('mock-encrypted:')) {
        throw new Error('decryption_failed')
      }
      return decoded.slice('mock-encrypted:'.length)
    })
    getSelectedStorageBackendMock.mockReturnValue('gnome_libsecret')
  })

  afterEach(() => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform
    })
  })

  describe('getDbEncryptionStatus', () => {
    it('returns strong backend for gnome_libsecret on linux', () => {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: 'linux'
      })
      getSelectedStorageBackendMock.mockReturnValue('gnome_libsecret')

      const status = getDbEncryptionStatus()

      expect(status.backend).toBe('gnome_libsecret')
      expect(status.isStrong).toBe(true)
    })

    it('returns strong backend for kwallet on linux', () => {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: 'linux'
      })
      getSelectedStorageBackendMock.mockReturnValue('kwallet5')

      const status = getDbEncryptionStatus()

      expect(status.backend).toBe('kwallet5')
      expect(status.isStrong).toBe(true)
    })

    it('returns strong backend for keychain on darwin', () => {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: 'darwin'
      })

      const status = getDbEncryptionStatus()

      expect(status.backend).toBe('keychain')
      expect(status.isStrong).toBe(true)
    })

    it('returns strong backend for dpapi on win32', () => {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: 'win32'
      })

      const status = getDbEncryptionStatus()

      expect(status.backend).toBe('dpapi')
      expect(status.isStrong).toBe(true)
    })

    it('returns weak backend for basic_text', () => {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: 'linux'
      })
      getSelectedStorageBackendMock.mockReturnValue('basic_text')

      const status = getDbEncryptionStatus()

      expect(status.backend).toBe('basic_text')
      expect(status.isStrong).toBe(false)
    })

    it('returns unavailable backend when encryption is not available', () => {
      isEncryptionAvailableMock.mockReturnValue(false)

      const status = getDbEncryptionStatus()

      expect(status.backend).toBe('unavailable')
      expect(status.isStrong).toBe(false)
    })
  })

  describe('encryptDbSecret', () => {
    it('returns empty string unchanged', () => {
      const result = encryptDbSecret('')

      expect(result).toBe('')
    })

    it('encrypts plaintext with ENC prefix when encryption is available', () => {
      const result = encryptDbSecret('mysecret')

      expect(result).toMatch(/^db\.safeStorage\.v1:/)
      expect(result).not.toContain('mysecret')
      expect(encryptStringMock).toHaveBeenCalledWith('mysecret')
    })

    it('returns RAW-prefixed plaintext when encryption is unavailable', () => {
      isEncryptionAvailableMock.mockReturnValue(false)

      const result = encryptDbSecret('mysecret')

      expect(result).toBe('db.plaintext.v1:mysecret')
    })

    it('throws when encryption fails on strong backend', () => {
      encryptStringMock.mockImplementation(() => {
        throw new Error('encryption_failed')
      })

      expect(() => encryptDbSecret('mysecret')).toThrow('db_secret_encrypt_failed')
    })
  })

  describe('decryptDbSecret', () => {
    it('returns empty string unchanged', () => {
      const result = decryptDbSecret('')

      expect(result).toBe('')
    })

    it('decrypts ENC-prefixed ciphertext', () => {
      const encrypted = encryptDbSecret('mysecret')

      const result = decryptDbSecret(encrypted)

      expect(result).toBe('mysecret')
    })

    it('decrypts RAW-prefixed plaintext', () => {
      const result = decryptDbSecret('db.plaintext.v1:mysecret')

      expect(result).toBe('mysecret')
    })

    it('throws on untagged value (fail-closed)', () => {
      expect(() => decryptDbSecret('untagged-secret')).toThrow('db_secret_unknown_format')
    })

    it('throws when safeStorage.decryptString fails (fail-closed)', () => {
      decryptStringMock.mockImplementation(() => {
        throw new Error('decryption_failed')
      })
      const encrypted = encryptDbSecret('mysecret')

      expect(() => decryptDbSecret(encrypted)).toThrow()
    })

    it('throws on corrupt base64 in ENC-prefixed value', () => {
      decryptStringMock.mockImplementation(() => {
        throw new Error('decryption_failed')
      })

      expect(() => decryptDbSecret('db.safeStorage.v1:not-valid-base64!!!')).toThrow()
    })
  })

  describe('isDbSecretAtRest', () => {
    it('returns false for undefined', () => {
      expect(isDbSecretAtRest(undefined)).toBe(false)
    })

    it('returns false for empty string', () => {
      expect(isDbSecretAtRest('')).toBe(false)
    })

    it('returns true for ENC-prefixed value', () => {
      expect(isDbSecretAtRest('db.safeStorage.v1:xyz')).toBe(true)
    })

    it('returns true for RAW-prefixed value', () => {
      expect(isDbSecretAtRest('db.plaintext.v1:xyz')).toBe(true)
    })

    it('returns false for untagged plaintext', () => {
      expect(isDbSecretAtRest('plaintext-secret')).toBe(false)
    })
  })

  describe('ensureDbSecretAtRest', () => {
    it('returns undefined unchanged', () => {
      expect(ensureDbSecretAtRest(undefined)).toBeUndefined()
    })

    it('returns empty string unchanged', () => {
      expect(ensureDbSecretAtRest('')).toBe('')
    })

    it('passes through already-tagged ENC value (idempotent)', () => {
      const tagged = 'db.safeStorage.v1:base64-ciphertext'

      const result = ensureDbSecretAtRest(tagged)

      expect(result).toBe(tagged)
      expect(encryptStringMock).not.toHaveBeenCalled()
    })

    it('passes through already-tagged RAW value (idempotent)', () => {
      const tagged = 'db.plaintext.v1:mysecret'

      const result = ensureDbSecretAtRest(tagged)

      expect(result).toBe(tagged)
      expect(encryptStringMock).not.toHaveBeenCalled()
    })

    it('encrypts untagged plaintext', () => {
      const result = ensureDbSecretAtRest('mysecret')

      expect(result).toMatch(/^db\.safeStorage\.v1:/)
      expect(result).not.toContain('mysecret')
      expect(encryptStringMock).toHaveBeenCalledWith('mysecret')
    })

    it('encrypts untagged plaintext to RAW when encryption unavailable', () => {
      isEncryptionAvailableMock.mockReturnValue(false)

      const result = ensureDbSecretAtRest('mysecret')

      expect(result).toBe('db.plaintext.v1:mysecret')
    })
  })

  describe('round-trip encryption/decryption', () => {
    it('encrypts and decrypts back to original with strong backend', () => {
      const plaintext = 'mypassword123'

      const encrypted = encryptDbSecret(plaintext)
      const decrypted = decryptDbSecret(encrypted)

      expect(decrypted).toBe(plaintext)
    })

    it('encrypts and decrypts back to original with weak backend', () => {
      isEncryptionAvailableMock.mockReturnValue(false)
      const plaintext = 'mypassword123'

      const encrypted = encryptDbSecret(plaintext)
      const decrypted = decryptDbSecret(encrypted)

      expect(decrypted).toBe(plaintext)
    })

    it('ensures idempotency: double-ensuring returns same value', () => {
      const plaintext = 'mypassword123'

      const encrypted1 = ensureDbSecretAtRest(plaintext)
      const encrypted2 = ensureDbSecretAtRest(encrypted1)

      expect(encrypted1).toBe(encrypted2)

      const decrypted1 = decryptDbSecret(encrypted1 ?? '')
      const decrypted2 = decryptDbSecret(encrypted2 ?? '')

      expect(decrypted1).toBe(plaintext)
      expect(decrypted2).toBe(plaintext)
    })
  })
})
