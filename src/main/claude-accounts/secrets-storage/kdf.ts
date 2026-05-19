import sodium from 'sodium-native'

// crypto_secretbox key size = 32 bytes.
export const KEY_BYTES = sodium.crypto_secretbox_KEYBYTES
// Argon2id default salt size from libsodium = 16 bytes.
export const SALT_BYTES = sodium.crypto_pwhash_SALTBYTES

// Why: m=64MB, t=3, parallelism=1 — libsodium's "MODERATE" preset. Targets ~1s
// on a 2024 laptop, low enough to keep the unlock UX snappy while resisting
// offline brute-force on a leaked secrets.enc.
const OPSLIMIT = sodium.crypto_pwhash_OPSLIMIT_MODERATE
const MEMLIMIT = sodium.crypto_pwhash_MEMLIMIT_MODERATE
const ALG = sodium.crypto_pwhash_ALG_ARGON2ID13

export function generateSalt(): Buffer {
  const salt = Buffer.alloc(SALT_BYTES)
  sodium.randombytes_buf(salt)
  return salt
}

export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  if (salt.length !== SALT_BYTES) {
    throw new Error(`Salt must be ${SALT_BYTES} bytes, got ${salt.length}.`)
  }
  const key = Buffer.alloc(KEY_BYTES)
  const passBuf = Buffer.from(passphrase, 'utf8')
  sodium.crypto_pwhash(key, passBuf, salt, OPSLIMIT, MEMLIMIT, ALG)
  // Why: do not zero passBuf here — the caller owns the passphrase lifetime.
  // The dedicated passphrase-prompt holder zeroes the canonical buffer on quit.
  return key
}
