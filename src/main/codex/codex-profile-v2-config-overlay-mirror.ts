import {
  cpSync,
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync
} from 'node:fs'
import { join } from 'node:path'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'

function isProfileV2ConfigOverlayName(fileName: string): boolean {
  return fileName.endsWith('.config.toml') && fileName !== 'config.toml'
}

// Why: Codex profile-v2 loads `${CODEX_HOME}/<name>.config.toml` when selected.
// Resource linking covers the profile-v2/ directory, not free-standing overlays.
export function syncSystemProfileV2ConfigOverlaysIntoManagedHome(): void {
  const systemHomePath = getSystemCodexHomePath()
  const managedHomePath = getOrcaManagedCodexHomePath()
  let entries: string[]
  try {
    entries = readdirSync(systemHomePath)
  } catch {
    return
  }
  for (const fileName of entries) {
    if (!isProfileV2ConfigOverlayName(fileName)) {
      continue
    }
    linkSystemProfileV2ConfigOverlay(systemHomePath, managedHomePath, fileName)
  }
}

function linkSystemProfileV2ConfigOverlay(
  systemHomePath: string,
  managedHomePath: string,
  fileName: string
): void {
  const sourcePath = join(systemHomePath, fileName)
  const targetPath = join(managedHomePath, fileName)
  if (!existsSync(sourcePath)) {
    return
  }
  try {
    if (
      lstatSync(targetPath).isSymbolicLink() &&
      profileOverlayLinkTargetsMatch(readlinkSync(targetPath), sourcePath)
    ) {
      return
    }
  } catch {
    // Target missing or unreadable — create below.
  }
  if (existsSync(targetPath)) {
    try {
      if (!lstatSync(targetPath).isSymbolicLink()) {
        // Why: leave non-link runtime files alone; they may be user-edited copies.
        return
      }
      unlinkSync(targetPath)
    } catch {
      return
    }
  }
  try {
    symlinkSync(sourcePath, targetPath)
  } catch {
    try {
      rmSync(targetPath, { force: true })
      cpSync(sourcePath, targetPath, { force: false, errorOnExist: true })
    } catch (error) {
      console.warn('[codex-config] Failed to link profile-v2 config overlay:', fileName, error)
    }
  }
}

function profileOverlayLinkTargetsMatch(actualTarget: string, expectedTarget: string): boolean {
  if (process.platform !== 'win32') {
    return actualTarget === expectedTarget
  }
  return (
    actualTarget.replace(/^\\\\\?\\/, '').toLowerCase() ===
    expectedTarget.replace(/^\\\\\?\\/, '').toLowerCase()
  )
}
