import { readFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { LinuxRootPackageType } from '../shared/update-status-types'

export type { LinuxRootPackageType }

// Why: `undefined` means "not resolved yet"; `null` is a resolved "not a root package".
let cachedPackageType: LinuxRootPackageType | null | undefined

// Bounded by construction: the marker is read at most once per process.
function warnMarkerUnusable(detail: string): void {
  console.warn(`[updater] linux package-type marker unusable: ${detail}`)
}

function readPackageTypeMarker(): LinuxRootPackageType | null {
  if (process.platform !== 'linux' || !app.isPackaged) {
    return null
  }
  const resourcesPath = process.resourcesPath
  if (typeof resourcesPath !== 'string' || resourcesPath.length === 0) {
    warnMarkerUnusable('resourcesPath unavailable')
    return null
  }
  let raw: string
  try {
    raw = readFileSync(path.join(resourcesPath, 'package-type'), 'utf8')
  } catch (error) {
    // Why: AppImage legitimately ships no marker, so only an unreadable one is worth reporting.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      warnMarkerUnusable('marker unreadable')
    }
    return null
  }
  const value = raw.trim()
  if (value === 'deb' || value === 'rpm') {
    return value
  }
  // Why: electron-updater also supports pacman, but this recovery path covers deb/rpm only — a
  // recognized marker is a deliberate scope cut, not a broken install.
  if (value !== 'pacman') {
    warnMarkerUnusable('marker is not deb or rpm')
  }
  return null
}

/**
 * The installed Linux package format, or null when this build does not install through a
 * root package. Reads only the packaged marker `electron-updater` itself uses — never distro
 * files, executable paths, or available package managers.
 */
export function getLinuxRootPackageType(): LinuxRootPackageType | null {
  if (cachedPackageType === undefined) {
    cachedPackageType = readPackageTypeMarker()
  }
  return cachedPackageType
}
