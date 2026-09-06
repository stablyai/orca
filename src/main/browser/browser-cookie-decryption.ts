import { createDecipheriv } from 'node:crypto'
import type { BrowserCookieImportSummary } from '../../shared/browser-workspace-types'
import type { EncryptionKeyResult } from './browser-cookie-sqlite'

// Why: Chromium 127+ prepends a 32-byte HMAC before the value; a hash is ~half non-printable, so ≥8 non-printable of the first 32 bytes flags the prefix.
const CHROMIUM_COOKIE_HMAC_LEN = 32

function hasHmacPrefix(buf: Buffer): boolean {
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

function stripHmac(buf: Buffer): Buffer {
  return hasHmacPrefix(buf) ? buf.subarray(CHROMIUM_COOKIE_HMAC_LEN) : buf
}

// Why: the version prefix is the only thing that survives a failed decrypt, so read it once and
// share it between the decrypt path and the failure attribution.
export function cookieEncryptionVersion(encryptedBuffer: Buffer): string | null {
  if (encryptedBuffer.length < 3) {
    return null
  }
  const version = encryptedBuffer.subarray(0, 3).toString('utf-8')
  return /^v\d\d$/.test(version) ? version : null
}

// Why: Chrome/Edge 140+ on Windows prefix every cookie with `v20` (app-bound encryption), which
// only the writing browser can unwrap. Classify it before decrypt so it is not folded into corruption.
export function isAppBoundEncryptedCookie(encryptedBuffer: Buffer): boolean {
  return cookieEncryptionVersion(encryptedBuffer) === 'v20'
}

// Why: a named cause must carry only its exact count; tied causes fall back to unknown.
export function buildUndecryptableWarning(counts: {
  decryptFailed: number
  appBoundFailed: number
  keyringUnavailableFailed: number
}): BrowserCookieImportSummary['warning'] {
  if (counts.decryptFailed === 0) {
    return undefined
  }
  const unknownFailed =
    counts.decryptFailed - counts.appBoundFailed - counts.keyringUnavailableFailed
  const rankedCauses = [
    { reason: 'app-bound-encryption' as const, count: counts.appBoundFailed },
    { reason: 'linux-keyring-unavailable' as const, count: counts.keyringUnavailableFailed },
    { reason: 'unknown' as const, count: unknownFailed }
  ].sort((left, right) => right.count - left.count)
  const [dominant, runnerUp] = rankedCauses

  if (dominant.reason === 'unknown' || dominant.count === runnerUp.count) {
    return { code: 'cookies-undecryptable', failedCookies: counts.decryptFailed, reason: 'unknown' }
  }

  const otherFailedCookies = counts.decryptFailed - dominant.count
  return {
    code: 'cookies-undecryptable',
    failedCookies: dominant.count,
    reason: dominant.reason,
    ...(otherFailedCookies > 0 ? { otherFailedCookies } : {})
  }
}

export function decryptCookieValueRaw(
  encryptedBuffer: Buffer,
  keyResult: EncryptionKeyResult
): Buffer | null {
  if (!encryptedBuffer || encryptedBuffer.length === 0) {
    return null
  }
  const version = encryptedBuffer.subarray(0, 3).toString('utf-8')
  if (!/^v\d\d$/.test(version)) {
    return null
  }

  if (keyResult.mode === 'aes-256-gcm') {
    return decryptAes256Gcm(encryptedBuffer.subarray(3), keyResult.key)
  }

  // AES-128-CBC (macOS and Linux)
  const key = version === 'v10' || version === 'v11' ? keyResult.keysByVersion[version] : undefined
  if (!key) {
    return null
  }

  const ciphertext = encryptedBuffer.subarray(3)
  if (!ciphertext.length) {
    return null
  }

  try {
    const iv = Buffer.alloc(16, ' ')
    const decipher = createDecipheriv('aes-128-cbc', key, iv)
    decipher.setAutoPadding(true)
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return stripHmac(decrypted)
  } catch {
    return null
  }
}

function decryptAes256Gcm(payload: Buffer, key: Buffer): Buffer | null {
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
    return stripHmac(decrypted)
  } catch {
    return null
  }
}
