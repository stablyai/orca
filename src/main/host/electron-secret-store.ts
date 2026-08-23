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

  describeProtectionGap(): string | null {
    if (!safeStorage.isEncryptionAvailable()) {
      // Why platform-specific: the fix differs, and "encryption unavailable" alone
      // sends users looking in the wrong place.
      return process.platform === 'linux'
        ? 'The OS keyring is unavailable, so secrets are stored unencrypted. Install and unlock gnome-keyring or kwallet to seal them.'
        : 'The OS keychain is unavailable, so secrets are stored unencrypted.'
    }
    // Why this is not folded into isEncryptionAvailable(): on Linux with no keyring,
    // Electron falls back to `basic_text`, which "encrypts" with a hardcoded password.
    // It round-trips, so sealing and unsealing genuinely work and must keep working —
    // reporting it unavailable would strand every credential already stored this way.
    // But it protects nothing, and reporting it as sealed is the actual lie.
    return describeLinuxBackendGap()
  }
}

/**
 * Why probed rather than called directly: `getSelectedStorageBackend` is `@platform
 * linux`, so it is genuinely absent on macOS and Windows — reading it unguarded is a
 * TypeError, and the type declaration does not say so. Tests that mock `safeStorage`
 * supply the method, so a mocked suite cannot catch that; this keeps the runtime honest
 * regardless of platform or Electron version.
 *
 * Returns null when the backend is unknown or unreadable: claiming a gap we cannot
 * prove would be its own kind of lie, and the caller has already established that
 * sealing works.
 */
function describeLinuxBackendGap(): string | null {
  if (process.platform !== 'linux') {
    return null
  }
  const probe = (safeStorage as Partial<typeof safeStorage>).getSelectedStorageBackend
  if (typeof probe !== 'function') {
    return null
  }
  let backend: string
  try {
    backend = probe.call(safeStorage)
  } catch {
    return null
  }
  // Why only basic_text: it "encrypts" with a hardcoded password, so it round-trips and
  // must keep working — but it protects nothing, and reporting it as sealed is the lie.
  return backend === 'basic_text'
    ? 'Secrets are obfuscated with a built-in key, not protected by the OS keyring. Install and unlock gnome-keyring or kwallet, then restart Orca, to seal them properly.'
    : null
}
