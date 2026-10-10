import { safeStorage } from 'electron'
import type { SecretDecryption, SecretStore } from '../../shared/secret-store'

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

  isEncryptionAvailableAsync(): Promise<boolean> {
    return safeStorage.isAsyncEncryptionAvailable()
  }

  encryptStringAsync(plainText: string): Promise<Buffer> {
    return safeStorage.encryptStringAsync(plainText)
  }

  async decryptStringAsync(cipher: Buffer): Promise<SecretDecryption> {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(cipher)
    return { plainText: result, shouldReEncrypt }
  }

  describeProtectionGap(): string | null {
    // Why availability first: it is the call that actually probes the keyring, so every
    // backend read below is free and cannot change which call blocks.
    if (!safeStorage.isEncryptionAvailable()) {
      // Why platform-specific: the fix differs, and "encryption unavailable" alone
      // sends users looking in the wrong place.
      if (process.platform !== 'linux') {
        return 'The OS keychain is unavailable, so secrets are stored unencrypted.'
      }
      return readLinuxBackend() === 'basic_text'
        ? // Chromium picks the backend from XDG_CURRENT_DESKTOP and recognises none of the
          // tiling compositors, so it never asks the secret service that is usually running
          // the whole time. Telling these users to install a keyring sends them after one
          // they already have.
          `Orca could not tell which keyring service this desktop uses${describeDesktop()}, so secrets are stored unencrypted — even if a secret service is already running. Start Orca with --password-store=gnome-libsecret (or --password-store=kwallet6 on KDE) to name one.`
        : 'The OS keyring is unavailable, so secrets are stored unencrypted. Install and unlock gnome-keyring or kwallet to seal them.'
    }
    // Why this is not folded into isEncryptionAvailable(): `basic_text` "encrypts" with a
    // hardcoded password, and Electron makes that key available only after an explicit
    // `setUsePlainTextEncryption(true)` (or `--password-store=basic`) — which this app never
    // asks for, so the branch is currently unreachable on Linux and stays for the day it is
    // not. Where it does apply, sealing round-trips and must keep working: reporting it
    // unavailable would strand every credential already stored that way. But it protects
    // nothing, and reporting it as sealed is the actual lie.
    return describeLinuxBackendGap()
  }
}

/** The active desktop, as a parenthetical for support triage, or '' when unset. */
function describeDesktop(): string {
  const desktop = process.env.XDG_CURRENT_DESKTOP?.trim()
  return desktop ? ` (XDG_CURRENT_DESKTOP=${desktop})` : ''
}

// Electron omits getSelectedStorageBackend at runtime outside Linux despite its type declaration.
function readLinuxBackend(): string | null {
  if (process.platform !== 'linux') {
    return null
  }
  const probe = (safeStorage as Partial<typeof safeStorage>).getSelectedStorageBackend
  if (typeof probe !== 'function') {
    return null
  }
  try {
    return probe.call(safeStorage)
  } catch {
    return null
  }
}

function describeLinuxBackendGap(): string | null {
  return readLinuxBackend() === 'basic_text'
    ? 'Secrets are obfuscated with a built-in key, not protected by the OS keyring. Install and unlock gnome-keyring or kwallet, then restart Orca, to seal them properly.'
    : null
}
