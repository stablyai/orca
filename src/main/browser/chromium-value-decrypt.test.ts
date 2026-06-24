import { describe, expect, it } from 'vitest'
import { createCipheriv, pbkdf2Sync } from 'crypto'
import {
  decryptChromiumValue,
  PBKDF2_ITERATIONS,
  PBKDF2_KEY_LENGTH,
  PBKDF2_SALT,
  type EncryptionKeyResult
} from './chromium-value-decrypt'

// Why: prove the moved AES-128-CBC (mac/linux) path round-trips a 'v10' blob.
function encryptV10Cbc(plaintext: Buffer | string, key: Buffer): Buffer {
  const iv = Buffer.alloc(16, ' ')
  const cipher = createCipheriv('aes-128-cbc', key, iv)
  const input = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext
  const body = Buffer.concat([cipher.update(input), cipher.final()])
  return Buffer.concat([Buffer.from('v10'), body])
}

// Why: build a buffer whose first 32 bytes look like an HMAC (≥8 non-printable
// bytes) followed by a real UTF-8 value, to test the password-safety regression.
function buildHmacPrefixedPayload(afterHmac: string): Buffer {
  // 32 bytes with 8 non-printable bytes scattered at known positions
  const hmac = Buffer.alloc(32, 0x41) // 'A' — printable baseline
  for (let i = 0; i < 8; i++) {
    hmac[i * 4] = 0x01 // non-printable
  }
  return Buffer.concat([hmac, Buffer.from(afterHmac, 'utf8')])
}

describe('decryptChromiumValue', () => {
  it('round-trips a v10 AES-128-CBC blob', () => {
    const key = pbkdf2Sync('pw', PBKDF2_SALT, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, 'sha1')
    const keyResult: EncryptionKeyResult = { key, mode: 'aes-128-cbc' }
    const blob = encryptV10Cbc('hunter2', key)
    expect(decryptChromiumValue(blob, keyResult)?.toString('utf8')).toBe('hunter2')
  })

  it('returns null for a non-decryptable blob', () => {
    const key = pbkdf2Sync('pw', PBKDF2_SALT, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, 'sha1')
    expect(decryptChromiumValue(Buffer.from('garbage'), { key, mode: 'aes-128-cbc' })).toBeNull()
  })

  it('strips HMAC prefix when stripHmacPrefix:true (cookie behavior preserved)', () => {
    const key = pbkdf2Sync('pw', PBKDF2_SALT, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, 'sha1')
    const keyResult: EncryptionKeyResult = { key, mode: 'aes-128-cbc' }
    const cookieValue = 'session-token-abc123'
    const payload = buildHmacPrefixedPayload(cookieValue)
    const blob = encryptV10Cbc(payload, key)
    const result = decryptChromiumValue(blob, keyResult, { stripHmacPrefix: true })
    // With stripping enabled the 32-byte HMAC prefix is removed, leaving only the cookie value.
    expect(result?.toString('utf8')).toBe(cookieValue)
  })

  it('does NOT strip HMAC-like prefix by default — password-safety regression guard', () => {
    const key = pbkdf2Sync('pw', PBKDF2_SALT, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, 'sha1')
    const keyResult: EncryptionKeyResult = { key, mode: 'aes-128-cbc' }
    const afterHmac = 'tail-value'
    const payload = buildHmacPrefixedPayload(afterHmac)
    const blob = encryptV10Cbc(payload, key)
    // Default (no opts): full decrypted bytes returned intact, including the HMAC-like prefix.
    const result = decryptChromiumValue(blob, keyResult)
    expect(result).toEqual(payload)
    // Confirm it was NOT silently truncated to just the tail.
    expect(result?.toString('utf8')).not.toBe(afterHmac)
  })
})
