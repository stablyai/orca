import { createDecipheriv } from 'node:crypto'

// Why: each platform uses a different mechanism to protect the Chromium cookie encryption key.
// macOS: PBKDF2(keychain password, "saltysalt", 1003 iterations) → AES-128-CBC
// Linux: PBKDF2(keyring password or "peanuts", "saltysalt", 1 iteration) → AES-128-CBC
// Windows: DPAPI-encrypted master key from Local State → AES-256-GCM

export type EncryptionKeyResult = {
  key: Buffer
  mode: 'aes-128-cbc' | 'aes-256-gcm'
  // Why: Linux v10 cookies use a hardcoded "peanuts" password while v11 uses the
  // keyring password. We need both keys to decrypt the full cookie set.
  fallbackKey?: Buffer
}

export const PBKDF2_ITERATIONS = 1003
export const PBKDF2_KEY_LENGTH = 16
export const PBKDF2_SALT = 'saltysalt'

// Why: some Chromium builds on Linux prepend a 32-byte HMAC to the plaintext
// before encrypting. After AES-CBC decryption, the raw output is:
//   [32-byte HMAC] [actual cookie value]
// Detection: the HMAC is a hash, so roughly half its bytes are non-printable
// ASCII. Real cookie values are overwhelmingly printable. If ≥8 of the first
// 32 bytes are non-printable, it's an HMAC prefix.
// This prefix is COOKIE-specific (domain-binding). Login Data passwords do NOT
// carry it — stripping is opt-in to avoid truncating long/non-ASCII passwords.
const CHROMIUM_COOKIE_HMAC_LEN = 32

export function hasHmacPrefix(buf: Buffer): boolean {
  if (buf.length <= CHROMIUM_COOKIE_HMAC_LEN) {
    return false
  }
  let nonPrintable = 0
  for (let i = 0; i < CHROMIUM_COOKIE_HMAC_LEN; i++) {
    if (buf[i] < 0x20 || buf[i] > 0x7e) {
      nonPrintable++
    }
  }
  return nonPrintable >= 8
}

export function stripHmac(buf: Buffer): Buffer {
  return hasHmacPrefix(buf) ? buf.subarray(CHROMIUM_COOKIE_HMAC_LEN) : buf
}

export function decryptChromiumValue(
  encryptedBuffer: Buffer,
  keyResult: EncryptionKeyResult,
  opts: { stripHmacPrefix?: boolean } = {}
): Buffer | null {
  if (!encryptedBuffer || encryptedBuffer.length === 0) {
    return null
  }
  const version = encryptedBuffer.subarray(0, 3).toString('utf-8')
  if (!/^v\d\d$/.test(version)) {
    return null
  }

  if (keyResult.mode === 'aes-256-gcm') {
    return decryptAes256Gcm(
      encryptedBuffer.subarray(3),
      keyResult.key,
      opts.stripHmacPrefix ?? false
    )
  }

  // AES-128-CBC (macOS and Linux)
  const ciphertext = encryptedBuffer.subarray(3)
  if (!ciphertext.length) {
    return Buffer.alloc(0)
  }

  // Why: Linux v10 uses "peanuts" key, v11 uses keyring key. Try the primary
  // key first, then fallback. macOS uses the same key for both versions.
  const keysToTry =
    version === 'v10' && keyResult.fallbackKey
      ? [keyResult.fallbackKey, keyResult.key]
      : [keyResult.key, ...(keyResult.fallbackKey ? [keyResult.fallbackKey] : [])]

  for (const key of keysToTry) {
    try {
      const iv = Buffer.alloc(16, ' ')
      const decipher = createDecipheriv('aes-128-cbc', key, iv)
      decipher.setAutoPadding(true)
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      return opts.stripHmacPrefix ? stripHmac(decrypted) : decrypted
    } catch {
      continue
    }
  }
  return null
}

export function decryptAes256Gcm(
  payload: Buffer,
  key: Buffer,
  stripHmacPrefix = false
): Buffer | null {
  // Why: Windows AES-256-GCM layout is: [12-byte nonce][ciphertext][16-byte auth tag]
  if (payload.length < 12 + 16) {
    return null
  }
  const nonce = payload.subarray(0, 12)
  const authTag = payload.subarray(-16)
  const ciphertext = payload.subarray(12, -16)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(authTag)
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return stripHmacPrefix ? stripHmac(decrypted) : decrypted
  } catch {
    return null
  }
}
