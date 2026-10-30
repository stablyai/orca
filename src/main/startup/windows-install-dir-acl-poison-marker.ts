import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Persist the probe's poison verdict immediately: crashes mid-repair can precede the repair-result marker. Later launches can gate before creating a renderer the deferred probe cannot save. */

export const WINDOWS_INSTALL_DIR_ACL_POISON_MARKER_FILE = 'windows-install-dir-acl-poison.json'
export const WINDOWS_INSTALL_DIR_ACL_POISON_SCHEME_VERSION = 1

type PoisonMarker = {
  schemeVersion: number
  installDir: string
  appVersion: string
  detectedAt: number
}

function markerPath(userDataPath: string): string {
  return join(userDataPath, WINDOWS_INSTALL_DIR_ACL_POISON_MARKER_FILE)
}

/** Reinstall/update changes the key and supplies a fresh DACL. */
export function hasInstallDirAclPoisonMarker(
  userDataPath: string,
  installDir: string,
  appVersion: string
): boolean {
  try {
    const parsed = JSON.parse(readFileSync(markerPath(userDataPath), 'utf-8')) as
      | Partial<PoisonMarker>
      | undefined
    return (
      parsed?.schemeVersion === WINDOWS_INSTALL_DIR_ACL_POISON_SCHEME_VERSION &&
      parsed.installDir === installDir &&
      parsed.appVersion === appVersion
    )
  } catch {
    return false
  }
}

export function writeInstallDirAclPoisonMarker(
  userDataPath: string,
  installDir: string,
  appVersion: string
): void {
  const marker: PoisonMarker = {
    schemeVersion: WINDOWS_INSTALL_DIR_ACL_POISON_SCHEME_VERSION,
    installDir,
    appVersion,
    detectedAt: Date.now()
  }
  try {
    if (!existsSync(userDataPath)) {
      mkdirSync(userDataPath, { recursive: true })
    }
    writeFileSync(markerPath(userDataPath), JSON.stringify(marker))
  } catch {
    // Without this best-effort marker the next launch falls back to late repair.
  }
}

export function clearInstallDirAclPoisonMarker(userDataPath: string): void {
  try {
    rmSync(markerPath(userDataPath), { force: true })
  } catch {
    // Stale markers cost one redundant grant pass.
  }
}
