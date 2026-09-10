import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getSecretStore,
  hasSecretStore,
  setSecretStore,
  _resetSecretStoreForTests
} from '../../shared/secret-store'
import { HostDatabaseVaultKeyProtection } from './database-vault-key-protection'

const originalStore = hasSecretStore() ? getSecretStore() : null
afterEach(() => (originalStore ? setSecretStore(originalStore) : _resetSecretStoreForTests()))

describe('database vault host key protection', () => {
  it('uses the installed host secret store without importing Electron', () => {
    setSecretStore({
      isEncryptionAvailable: () => true,
      describeProtectionGap: () => null,
      encryptString: (value) => Buffer.from(`sealed:${value}`),
      decryptString: (value) => value.toString().slice('sealed:'.length)
    })
    const protection = new HostDatabaseVaultKeyProtection()
    const key = Buffer.alloc(32, 7)
    const stored = protection.protect(key)
    expect(stored.protection).toBe('os')
    expect(protection.unprotect(stored)).toEqual(key)
  })

  it('retains the existing owner-only file fallback when the host cannot seal secrets', () => {
    const encrypt = vi.fn()
    setSecretStore({
      isEncryptionAvailable: () => false,
      describeProtectionGap: () => 'unavailable',
      encryptString: encrypt,
      decryptString: vi.fn()
    })
    const protection = new HostDatabaseVaultKeyProtection()
    const key = Buffer.alloc(32, 8)
    const stored = protection.protect(key)
    expect(stored.protection).toBe('local-file')
    expect(protection.unprotect(stored)).toEqual(key)
    expect(encrypt).not.toHaveBeenCalled()
    expect(() => protection.unprotect({ protection: 'os', payload: 'sealed' })).toThrow(
      'unavailable'
    )
  })

  it('does not describe a backend with a built-in key as OS protection', () => {
    setSecretStore({
      isEncryptionAvailable: () => true,
      describeProtectionGap: () => 'built-in key',
      encryptString: vi.fn(),
      decryptString: vi.fn()
    })
    expect(new HostDatabaseVaultKeyProtection().protect(Buffer.alloc(32)).protection).toBe(
      'local-file'
    )
  })
})
