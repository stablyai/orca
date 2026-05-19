import { describe, expect, it } from 'vitest'
import { deriveKey, generateSalt, KEY_BYTES, SALT_BYTES } from './kdf'

describe('kdf', () => {
  it('generateSalt produces SALT_BYTES random bytes', () => {
    const a = generateSalt()
    const b = generateSalt()
    expect(a.length).toBe(SALT_BYTES)
    expect(b.length).toBe(SALT_BYTES)
    expect(a.equals(b)).toBe(false)
  })

  it('deriveKey returns KEY_BYTES from passphrase + salt (deterministic)', () => {
    const salt = Buffer.alloc(SALT_BYTES, 0x42)
    const k1 = deriveKey('hunter2', salt)
    const k2 = deriveKey('hunter2', salt)
    expect(k1.length).toBe(KEY_BYTES)
    expect(k1.equals(k2)).toBe(true)
  })

  it('different passphrase → different key', () => {
    const salt = Buffer.alloc(SALT_BYTES, 0x42)
    const k1 = deriveKey('hunter2', salt)
    const k2 = deriveKey('hunter3', salt)
    expect(k1.equals(k2)).toBe(false)
  })

  it('different salt → different key', () => {
    const k1 = deriveKey('hunter2', Buffer.alloc(SALT_BYTES, 0x01))
    const k2 = deriveKey('hunter2', Buffer.alloc(SALT_BYTES, 0x02))
    expect(k1.equals(k2)).toBe(false)
  })
})
