import { safeStorage } from 'electron'
import { usesMockKeychain } from '../startup/chromium-policy/configure-dev-keychain'

import {
  MOCK_KEYCHAIN_CIPHERTEXT_PREFIX as MOCK_CIPHERTEXT_PREFIX,
  isMockKeychainCiphertext
} from '../../shared/secure-storage/secret-at-rest-protection'

let withheldReason: string | null = null

/** Withhold synchronous safeStorage calls after a probe finds an unreachable keychain, avoiding headless prompt hangs. */
export function withholdSafeStorage(reason: string): void {
  withheldReason ??= reason
}

export function safeStorageWithheldReason(): string | null {
  return withheldReason
}

export class SafeStorageWithheldError extends Error {
  constructor(reason: string) {
    super(`secrets_unavailable: ${reason}`)
    this.name = 'SafeStorageWithheldError'
  }
}

/** `safeStorage` behind the run-wide withhold; use this, never `electron.safeStorage`. */
export const guardedSafeStorage = {
  isEncryptionAvailable(): boolean {
    return withheldReason === null && safeStorage.isEncryptionAvailable()
  },
  encryptString(plainText: string): Buffer {
    if (withheldReason !== null) {
      throw new SafeStorageWithheldError(withheldReason)
    }
    const cipher = safeStorage.encryptString(plainText)
    return usesMockKeychain() ? Buffer.concat([MOCK_CIPHERTEXT_PREFIX, cipher]) : cipher
  },
  decryptString(cipher: Buffer): string {
    if (withheldReason !== null) {
      throw new SafeStorageWithheldError(withheldReason)
    }
    const isMockCipher = isMockKeychainCiphertext(cipher)
    if (isMockCipher !== usesMockKeychain()) {
      throw new Error('Credential was encrypted with a different keychain mode')
    }
    return safeStorage.decryptString(
      isMockCipher ? cipher.subarray(MOCK_CIPHERTEXT_PREFIX.length) : cipher
    )
  }
}

export function resetSafeStorageWithholdForTests(): void {
  withheldReason = null
}
