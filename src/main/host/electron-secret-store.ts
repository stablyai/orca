import { safeStorage } from 'electron'
import type { SecretStore } from '../../shared/secret-store'

/**
 * Electron-backed SecretStore for the desktop app: a pass-through to
 * `electron.safeStorage`, which seals against the OS keychain.
 */
export class ElectronSecretStore implements SecretStore {
  isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  encryptString(plainText: string): Buffer {
    return safeStorage.encryptString(plainText)
  }

  decryptString(cipher: Buffer): string {
    return safeStorage.decryptString(cipher)
  }

  describeUnavailable(): string | null {
    if (safeStorage.isEncryptionAvailable()) {
      return null
    }
    // Why platform-specific: the fix differs, and "encryption unavailable" alone
    // sends users looking in the wrong place.
    return process.platform === 'linux'
      ? 'The OS keyring is unavailable, so secrets are stored unencrypted. Install and unlock gnome-keyring or kwallet to seal them.'
      : 'The OS keychain is unavailable, so secrets are stored unencrypted.'
  }
}
