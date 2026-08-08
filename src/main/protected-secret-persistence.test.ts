import { beforeEach, describe, expect, it, vi } from 'vitest'

const cipherState = { available: true }

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => cipherState.available,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`),
    decryptString: (ciphertext: Buffer) => ciphertext.toString().slice('encrypted:'.length)
  }
}))

describe('ProtectedSecretPersistence', () => {
  beforeEach(() => {
    cipherState.available = true
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
})
