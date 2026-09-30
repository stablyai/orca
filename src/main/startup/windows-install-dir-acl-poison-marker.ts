import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * "This install directory was found poisoned and has not been proven healthy since."
 *
 * Why a separate marker from `windows-install-dir-acl-repair.json`: that one is
 * written after an attempt finishes, so a launch the poison kills mid-repair
 * leaves no state at all and the next launch repeats the whole late-repair dance.
 * This one is written the moment the probe's verdict lands, and it is the only
 * thing that lets a later launch know it is poisoned *before* it creates a window
 * — the probe itself cannot answer that early. Same tiny synchronous-JSON shape
 * as `gpu-fallback-marker.ts`, for the same reason.
 */

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

/** Keyed on both: a reinstall elsewhere or an update ships files with a fresh DACL. */
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
    return false // missing or corrupt -> treat the install as healthy
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
    // Best effort: without it the next launch just falls back to today's late repair.
  }
}

export function clearInstallDirAclPoisonMarker(userDataPath: string): void {
  try {
    rmSync(markerPath(userDataPath), { force: true })
  } catch {
    // Best effort; a stale marker only costs one redundant icacls pass.
  }
}
