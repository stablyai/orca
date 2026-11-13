import { beforeEach, describe, expect, it } from 'vitest'
import { setSecretStore } from '../../shared/secret-store'

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
})
