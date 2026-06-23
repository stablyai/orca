import { accessSync, constants, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  type DetectedImportBrowser,
  type PasswordImportResult
} from '../../shared/browser-credential-types'
import { getEncryptionKey } from './chromium-encryption-key'
import { readChromiumLogins } from './chromium-login-import'
import {
  CHROMIUM_BROWSERS,
  browserRootPath,
  detectChromiumBrowsers,
  isSafeBrowserProfileDirectory
} from './chromium-profile-discovery'
import { copyChromiumStoreToTemp } from './sqlite-store-copy'

export type { DetectedImportBrowser, PasswordImportResult }

// Why: the vault interface is structural — any object with importMany satisfies it,
// keeping this service decoupled from the concrete BrowserCredentialVault class.
type VaultLike = {
  importMany: (entries: { origin: string; username: string; password: string }[]) => {
    added: number
    skipped: number
    invalid: number
  }
}

/**
 * Returns every Chromium browser installed on this machine that has at least
 * one profile with a readable Login Data file.
 */
export function detectPasswordImportBrowsers(): DetectedImportBrowser[] {
  const detected = detectChromiumBrowsers((root, profileDir) => {
    const candidate = join(root, profileDir, 'Login Data')
    // Why: only consider a browser "importable" if the Login Data file physically
    // exists AND is readable — avoids returning browsers that are installed but
    // have never been used, and prevents listing files that would fail at import
    // due to permission errors (e.g. locked by the OS or owned by another user).
    if (!existsSync(candidate)) {
      return null
    }
    try {
      accessSync(candidate, constants.R_OK)
      return candidate
    } catch {
      return null
    }
  })

  return detected.map((b) => ({
    family: b.family,
    label: b.label,
    profiles: b.profiles,
    selectedProfile: b.selectedProfile
  }))
}

/**
 * Imports passwords from the specified browser profile into the vault.
 *
 * Security contract: `args.browserProfile` is a profile directory name (e.g.
 * "Default"), never a filesystem path. The renderer only passes a family + a
 * profile id; this service constructs all filesystem paths internally after
 * validating the profile id with `isSafeBrowserProfileDirectory`.
 */
export function importPasswordsFromBrowser(
  vault: VaultLike,
  args: { browserFamily: string; browserProfile?: string }
): PasswordImportResult {
  try {
    // Step 1: look up the browser definition.
    const def = CHROMIUM_BROWSERS.find((b) => b.family === args.browserFamily)
    if (!def) {
      return { ok: false, reason: `Unknown browser family: ${args.browserFamily}` }
    }

    // Step 2: detect installed browsers to get the selectedProfile default.
    const detectedBrowsers = detectPasswordImportBrowsers()
    const detectedBrowser = detectedBrowsers.find((b) => b.family === args.browserFamily)

    const profileDir = args.browserProfile ?? detectedBrowser?.selectedProfile ?? 'Default'

    // Why: validate BEFORE constructing any filesystem path — the renderer must
    // never pass traversal sequences; reject ../, /, and \ here unconditionally.
    if (!isSafeBrowserProfileDirectory(profileDir)) {
      return { ok: false, reason: `Unsafe browser profile directory: ${profileDir}` }
    }

    // Step 3: determine the browser root and resolve the Login Data path.
    const root = browserRootPath(def)
    if (!root) {
      return { ok: false, reason: `Could not determine browser data directory for ${def.label}` }
    }

    const loginDataPath = join(root, profileDir, 'Login Data')

    // Step 4: retrieve the OS encryption key.
    // Pass the Local State path for Windows DPAPI decryption.
    const localStatePath = join(root, 'Local State')
    const keyResult = getEncryptionKey(def.keychainService, def.keychainAccount, localStatePath)
    if (!keyResult) {
      return { ok: false, reason: 'keychain access denied' }
    }

    // Step 5: copy the locked DB, read logins, import into vault, always cleanup.
    const { tempDbPath, cleanup } = copyChromiumStoreToTemp(loginDataPath)
    try {
      const logins = readChromiumLogins(tempDbPath, keyResult)
      const summary = vault.importMany(logins)

      const profileLabel =
        detectedBrowser?.profiles.find((p) => p.directory === profileDir)?.name ?? profileDir

      return {
        ok: true,
        browserLabel: def.label,
        profileLabel,
        added: summary.added,
        skipped: summary.skipped,
        invalid: summary.invalid
      }
    } finally {
      // Why: cleanup always runs — even on readChromiumLogins or vault.importMany
      // failure — so the temp directory is never left behind.
      cleanup()
    }
  } catch (err) {
    // Why: the caller (IPC handler) must never receive a thrown error — every
    // failure mode maps to a typed result so the renderer always gets a response.
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: message }
  }
}
