import { safeStorage } from 'electron'

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
    return safeStorage.encryptString(plainText)
  },
  decryptString(cipher: Buffer): string {
    if (withheldReason !== null) {
      throw new SafeStorageWithheldError(withheldReason)
    }
    return safeStorage.decryptString(cipher)
  }
}

export function resetSafeStorageWithholdForTests(): void {
  withheldReason = null
}
