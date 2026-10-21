import { safeStorage } from 'electron'

let withheldReason: string | null = null

/**
 * Stop every in-process keychain call for the rest of this run.
 *
 * Why: `safeStorage` is synchronous, and against a keychain that needs a prompt nobody can
 * answer (headless serve with no GUI session) it blocks the main thread indefinitely. Once
 * an out-of-process probe has shown that, callers get "unavailable" instead of a frozen host.
 */
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

/** Test seam: restore the unwithheld state. */
export function resetSafeStorageWithholdForTests(): void {
  withheldReason = null
}
