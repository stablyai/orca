import { safeStorage } from 'electron'
import { guardedSafeStorage, safeStorageWithheldReason } from './safe-storage-availability'
import type { SecretStore } from '../../shared/secret-store'

export class ElectronSecretStore implements SecretStore {
  isEncryptionAvailable(): boolean {
    return guardedSafeStorage.isEncryptionAvailable()
  }

  encryptString(plainText: string): Buffer {
    return guardedSafeStorage.encryptString(plainText)
  }

  decryptString(cipher: Buffer): string {
    return guardedSafeStorage.decryptString(cipher)
  }

  describeProtectionGap(): string | null {
    const withheld = safeStorageWithheldReason()
    if (withheld !== null) {
      return `The OS keychain is unavailable for this run (${withheld}), so secrets are stored unencrypted. Start orca serve from a logged-in desktop session, or unlock the login keychain, to seal them.`
    }
    // Availability probes the keyring; backend reads below do not.
    if (!safeStorage.isEncryptionAvailable()) {
      // Remediation differs by platform.
      if (process.platform !== 'linux') {
        return 'The OS keychain is unavailable, so secrets are stored unencrypted.'
      }
      return readLinuxBackend() === 'basic_text'
        ? // Chromium may leave an installed secret service unselected on unrecognized tiling desktops.
          `Orca could not tell which keyring service this desktop uses${describeDesktop()}, so secrets are stored unencrypted — even if a secret service is already running. Start Orca with --password-store=gnome-libsecret (or --password-store=kwallet6 on KDE) to name one.`
        : 'The OS keyring is unavailable, so secrets are stored unencrypted. Install and unlock gnome-keyring or kwallet to seal them.'
    }
    // basic_text uses a built-in password: report the gap without stranding credentials by disabling sealing.
    return describeLinuxBackendGap()
  }
}

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
