import { describe, expect, it } from 'vitest'
import { encryptSecret, decryptSecret, NONCE_BYTES } from './secretbox'
import { deriveKey, generateSalt } from './kdf'

describe('secretbox', () => {
  const key = deriveKey('hunter2', generateSalt())

  it('round-trips a UTF-8 secret', () => {
    const { ciphertext, nonce } = encryptSecret('sk-ant-abc123', key)
    expect(nonce.length).toBe(NONCE_BYTES)
    const plain = decryptSecret(ciphertext, nonce, key)
    expect(plain).toBe('sk-ant-abc123')
  })

  it('round-trips an empty string', () => {
    const { ciphertext, nonce } = encryptSecret('', key)
    expect(decryptSecret(ciphertext, nonce, key)).toBe('')
  })

  it('different encryptions of the same secret use different nonces', () => {
    const a = encryptSecret('same', key)
    const b = encryptSecret('same', key)
    expect(a.nonce.equals(b.nonce)).toBe(false)
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false)
  })

  it('decryptSecret with wrong key throws', () => {
    const { ciphertext, nonce } = encryptSecret('sk', key)
    const otherKey = deriveKey('wrong', generateSalt())
    expect(() => decryptSecret(ciphertext, nonce, otherKey)).toThrow(/decrypt|verif/i)
  })

  it('decryptSecret with tampered ciphertext throws', () => {
    const { ciphertext, nonce } = encryptSecret('sk', key)
    ciphertext[0] = ciphertext[0] ^ 0xff
    expect(() => decryptSecret(ciphertext, nonce, key)).toThrow(/decrypt|verif/i)
  })
})
