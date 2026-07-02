import { safeStorage } from 'electron'
import type { DbEncryptionStatus } from '../../shared/database-types'

// Tagged at-rest representation so decrypt is unambiguous and fail-closed:
//   ENC_PREFIX → real safeStorage ciphertext (base64)
//   RAW_PREFIX → warn-and-store plaintext (no OS crypto backend available)
const ENC_PREFIX = 'db.safeStorage.v1:'
const RAW_PREFIX = 'db.plaintext.v1:'

// Why: a connection's password is recoverable from disk unless the OS exposes a
// real keystore. basic_text uses a hardcoded key (Electron still reports
// isEncryptionAvailable() === true for it), so it is NOT strong. macOS Keychain
// and Windows DPAPI are strong whenever encryption is available;
// getSelectedStorageBackend() is Linux-only.
const KNOWN_STRONG_BACKENDS = new Set([
  'gnome_libsecret',
  'kwallet',
  'kwallet5',
  'kwallet6',
  'keychain',
  'dpapi'
])

function selectedBackend(): string {
  if (!safeStorage.isEncryptionAvailable()) {
    return 'unavailable'
  }
  if (process.platform === 'darwin') {
    return 'keychain'
  }
  if (process.platform === 'win32') {
    return 'dpapi'
  }
  try {
    return safeStorage.getSelectedStorageBackend()
  } catch {
    return 'unknown'
  }
}

export function getDbEncryptionStatus(): DbEncryptionStatus {
  const backend = selectedBackend()
  return { backend, isStrong: KNOWN_STRONG_BACKENDS.has(backend) }
}

export function isDbSecretAtRest(value: string | undefined): boolean {
  return !!value && (value.startsWith(ENC_PREFIX) || value.startsWith(RAW_PREFIX))
}

// Encrypt a password into its tagged at-rest form. Uses the OS keystore whenever
// available (strong OR basic_text — both decrypt via safeStorage); only falls
// back to tagged plaintext when no backend exists at all (warn-and-store). A
// strong backend that throws mid-encrypt FAILS CLOSED rather than silently
// downgrading to a recoverable secret.
export function encryptDbSecret(plaintext: string): string {
  if (!plaintext) {
    return plaintext
  }
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return ENC_PREFIX + safeStorage.encryptString(plaintext).toString('base64')
    } catch {
      throw new Error('db_secret_encrypt_failed')
    }
  }
  return RAW_PREFIX + plaintext
}

// Idempotent: encrypt only if the value is not already in tagged at-rest form.
// Used by the persistence write paths to guarantee no plaintext password is ever
// written to disk, even if one leaked into in-memory state.
export function ensureDbSecretAtRest(value: string | undefined): string | undefined {
  if (!value || isDbSecretAtRest(value)) {
    return value
  }
  return encryptDbSecret(value)
}

// Strict, fail-closed decrypt. Unlike the cookie-grade decrypt (which returns the
// ciphertext on failure), a corrupt or keychain-changed value THROWS so callers
// surface "password could not be decrypted on this machine" instead of handing a
// bogus credential to a driver.
export function decryptDbSecret(stored: string): string {
  if (!stored) {
    return stored
  }
  if (stored.startsWith(RAW_PREFIX)) {
    return stored.slice(RAW_PREFIX.length)
  }
  if (stored.startsWith(ENC_PREFIX)) {
    return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'))
  }
  // This feature never wrote an untagged secret; treat anything else as corrupt.
  throw new Error('db_secret_unknown_format')
}
