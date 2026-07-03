import { safeStorage } from 'electron'
import type { SecretStore } from '../../shared/secret-store'

/**
 * Electron-backed SecretStore (OS keychain via safeStorage). Used by the desktop
 * app; behavior is unchanged from calling safeStorage directly.
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
}
