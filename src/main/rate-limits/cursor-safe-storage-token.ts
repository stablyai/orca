import { pbkdf2Sync } from 'node:crypto'
import { readKeychainPassword } from '../macos-keychain/generic-password'
import { decryptCookieValueRaw } from '../browser/cookies/sources/browser-cookie-decryption'

// Cursor 3.x encrypts IDE auth tokens at rest with Electron safeStorage (`cursor.storage.authTokenEncryptionAtRest`).
const SAFE_STORAGE_PREFIX = 'cursor-safe-storage:v1:'
const MAC_KEYCHAIN_SERVICE = 'Cursor Safe Storage'
const MAC_KEYCHAIN_ACCOUNT = 'Cursor Key'

export type CursorStoredTokenResult =
  | { status: 'ok'; token: string }
  | { status: 'unsupported' }
  | { status: 'error'; error: string }

export function isCursorSafeStorageToken(stored: string): boolean {
  return stored.startsWith(SAFE_STORAGE_PREFIX)
}

/** Decrypts a macOS safeStorage payload (`v10` + AES-128-CBC) with Cursor's keychain password. */
export function decryptCursorSafeStorageToken(stored: string, password: string): string | null {
  const payload = Buffer.from(stored.slice(SAFE_STORAGE_PREFIX.length), 'base64')
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
  const plaintext = decryptCookieValueRaw(
    payload,
    { mode: 'aes-128-cbc', keysByVersion: { v10: key } },
    ''
  )
  const token = plaintext?.toString('utf8').trim()
  return token ? token : null
}

/** Returns the plaintext IDE token, decrypting it when Cursor stored it encrypted. */
export async function readCursorDesktopToken(stored: string): Promise<CursorStoredTokenResult> {
  if (!isCursorSafeStorageToken(stored)) {
    return { status: 'ok', token: stored }
  }
  if (process.platform !== 'darwin') {
    return { status: 'unsupported' }
  }
  try {
    const password = await readKeychainPassword(MAC_KEYCHAIN_SERVICE, MAC_KEYCHAIN_ACCOUNT)
    const token = password ? decryptCursorSafeStorageToken(stored, password) : null
    return token
      ? { status: 'ok', token }
      : { status: 'error', error: 'Unable to decrypt the Cursor IDE login' }
  } catch {
    return {
      status: 'error',
      error: 'Unable to read the Cursor IDE encryption key from the macOS Keychain'
    }
  }
}
