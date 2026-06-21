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
function encryptV10Cbc(plaintext: string, key: Buffer): Buffer {
  const iv = Buffer.alloc(16, ' ')
  const cipher = createCipheriv('aes-128-cbc', key, iv)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([Buffer.from('v10'), body])
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
})
