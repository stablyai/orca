import { beforeEach, describe, expect, it } from 'vitest'
import { _resetSecretStoreForTests, setSecretStore } from '../shared/secret-store'

const cipherState = { available: true }

describe('ProtectedSecretPersistence', () => {
  beforeEach(() => {
    cipherState.available = true
    setSecretStore({
      isEncryptionAvailable: () => cipherState.available,
      encryptString: (plaintext) => Buffer.from(`encrypted:${plaintext}`),
      decryptString: (ciphertext) => ciphertext.toString().slice('encrypted:'.length),
      describeProtectionGap: () => null
    })
  })

  it('surfaces an uninstalled secret store instead of degrading silently', async () => {
    // Why: a missing setSecretStore() is a startup bug. If the availability check
    // swallows it, encrypt() hands back an empty blob and decryptWithStatus() reports
    // 'unavailable' — a real secret silently not stored, which is the outcome the
    // port throws to prevent.
    const { ProtectedSecretPersistence } = await import('./protected-secret-persistence')
    const secrets = new ProtectedSecretPersistence()
    _resetSecretStoreForTests()

    expect(() => secrets.encrypt('slot', 'token')).toThrow(/SecretStore not initialized/)
  })

  it('evicts dynamic slots across repeated SSH recovery lifecycles', async () => {
    const { ProtectedSecretPersistence, sshPtyOwnerLeaseSecretSlot } =
      await import('./protected-secret-persistence')
    const secrets = new ProtectedSecretPersistence()
    const slots = Array.from({ length: 100 }, (_, index) =>
      sshPtyOwnerLeaseSecretSlot(`ssh-${index}`)
    )

    for (const slot of slots) {
      expect(secrets.encrypt(slot, 'owner-lease').blob).not.toBe('owner-lease')
      secrets.removeRetainedBlob(slot)
    }

    cipherState.available = false
    for (const slot of slots) {
      expect(secrets.encrypt(slot, 'replacement-lease')).toEqual({ blob: '', degraded: true })
    }
  })

  it('keeps unavailable ciphertext sealed across recovery until replacement or clear', async () => {
    const { ProtectedSecretPersistence } = await import('./protected-secret-persistence')
    const secrets = new ProtectedSecretPersistence()
    const slot = 'protected-slot'
    const ciphertext = Buffer.from('encrypted:original').toString('base64')

    cipherState.available = false
    expect(secrets.decryptWithStatus(slot, ciphertext)).toEqual({
      plaintext: '',
      status: 'unavailable'
    })
    expect(secrets.isSealed(slot, ciphertext)).toBe(true)
    expect(secrets.encrypt(slot, '')).toEqual({
      blob: ciphertext,
      degraded: true,
      hashValue: ciphertext
    })
    expect(secrets.hasPendingEncryption()).toBe(false)

    cipherState.available = true
    expect(secrets.encrypt(slot, '')).toEqual({
      blob: ciphertext,
      degraded: false,
      hashValue: ciphertext
    })
    expect(secrets.encrypt(slot, 'replacement').blob).not.toBe(ciphertext)

    secrets.removeRetainedBlob(slot)
    expect(secrets.encrypt(slot, '')).toEqual({ blob: '', degraded: false })
  })

  it('keeps deferred encryption pending until its retention update commits', async () => {
    const { ProtectedSecretPersistence } = await import('./protected-secret-persistence')
    const secrets = new ProtectedSecretPersistence()
    cipherState.available = false
    secrets.encrypt('slot', 'pending')
    expect(secrets.hasPendingEncryption()).toBe(true)
    cipherState.available = true
    const encrypted = secrets.encrypt('slot', 'pending')
    expect(secrets.hasPendingEncryption()).toBe(true)
    if (!encrypted.retentionUpdate) {
      throw new Error('Expected a retention update')
    }
    secrets.commitRetentionUpdates([encrypted.retentionUpdate])
    expect(secrets.hasPendingEncryption()).toBe(false)
  })

  it('retires a deferred empty secret without retaining a phantom retry', async () => {
    const { ProtectedSecretPersistence } = await import('./protected-secret-persistence')
    const secrets = new ProtectedSecretPersistence()
    cipherState.available = false
    secrets.encrypt('slot', 'pending')
    const cleared = secrets.encrypt('slot', '')
    expect(secrets.hasPendingEncryption()).toBe(true)
    if (!cleared.retentionUpdate) {
      throw new Error('Expected a retention update')
    }
    secrets.commitRetentionUpdates([cleared.retentionUpdate])
    expect(secrets.hasPendingEncryption()).toBe(false)
  })
})
