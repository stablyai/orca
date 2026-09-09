import { readFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { hasTrustedPackageManagerFor } from './linux-package-install-command'
import type { LinuxRootPackageType } from '../shared/update-status-types'

export type { LinuxRootPackageType }

/** The packaged Linux format that controls how updates may be installed. */
export type LinuxPackageType = LinuxRootPackageType | 'non-root' | 'unusable'

// Why: `undefined` means "not resolved yet"; every other value is stable for this process.
let cachedPackageType: LinuxPackageType | undefined
let cachedExternallyManaged: boolean | undefined

// Bounded by construction: the marker is read at most once per process.
function warnMarkerUnusable(detail: string): void {
  console.warn(`[updater] linux package-type marker unusable: ${detail}`)
}

function isAbsolutePathString(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && !value.includes('\0') && path.isAbsolute(value)
  )
}

function isInsideDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

export function isLegacyAppImageRuntimeIdentity(identity: {
  appImagePath: unknown
  appDirPath: unknown
  execPath: unknown
  resourcesPath: unknown
}): boolean {
  if (
    !isAbsolutePathString(identity.appImagePath) ||
    !isAbsolutePathString(identity.appDirPath) ||
    !isAbsolutePathString(identity.execPath) ||
    !isAbsolutePathString(identity.resourcesPath)
  ) {
    return false
  }
  return (
    isInsideDirectory(identity.appDirPath, identity.execPath) &&
    isInsideDirectory(identity.appDirPath, identity.resourcesPath)
  )
}

function hasLegacyAppImageRuntimeIdentity(resourcesPath: unknown): boolean {
  return isLegacyAppImageRuntimeIdentity({
    appImagePath: process.env.APPIMAGE,
    appDirPath: process.env.APPDIR,
    execPath: process.execPath,
    resourcesPath
  })
}

function readPackageTypeMarker(): LinuxPackageType {
  if (process.platform !== 'linux' || !app.isPackaged) {
    return 'non-root'
  }
  const resourcesPath = process.resourcesPath
  if (typeof resourcesPath !== 'string' || resourcesPath.length === 0) {
    warnMarkerUnusable('resourcesPath unavailable')
    return 'unusable'
  }
  let raw: string
  try {
    raw = readFileSync(path.join(resourcesPath, 'package-type'), 'utf8')
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException)?.code === 'ENOENT' &&
      hasLegacyAppImageRuntimeIdentity(resourcesPath)
    ) {
      return 'non-root'
    }
    warnMarkerUnusable(
      (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'marker missing' : 'marker unreadable'
    )
    return 'unusable'
  }
  const value = raw.trim()
  if (value === 'deb' || value === 'rpm') {
    return value
  }
  if (value === 'AppImage') {
    return 'non-root'
  }
  warnMarkerUnusable('marker is not AppImage, deb, or rpm')
  return 'unusable'
}

/**
 * Resolves the installed Linux package format. Packaged builds fail closed when their marker is
 * missing or unusable unless the legacy APPIMAGE runtime identity is valid. Unpackaged, non-Linux,
 * and identified AppImage runs are non-root.
 */
export function getLinuxPackageType(): LinuxPackageType {
  if (cachedPackageType === undefined) {
    cachedPackageType = readPackageTypeMarker()
  }
  return cachedPackageType
}

/** Returns a root package type when this build supports manual package recovery. */
export function getLinuxRootPackageType(): LinuxRootPackageType | null {
  const packageType = getLinuxPackageType()
  return packageType === 'deb' || packageType === 'rpm' ? packageType : null
}

/**
 * Whether the marker claims a root package format this host cannot install. Repackagers (AUR, Nix,
 * container rebuilds) unpack Orca's .deb and inherit its `package-type` verbatim, so the marker
 * describes the artifact Orca was built as, never the system that now owns the install. Without a
 * matching package manager no downloaded package can ever be applied here.
 *
 * A false positive is impossible by construction: this reuses the exact manager lists and resolver
 * that `buildLinuxPackageInstallCommand` already loops over, so any host flagged here would have
 * failed with `no-package-manager` after the download anyway. The gate only moves that verdict
 * earlier — it never refuses a host that could have installed the update.
 */
export function isExternallyManagedLinuxInstall(): boolean {
  if (cachedExternallyManaged === undefined) {
    const packageType = getLinuxRootPackageType()
    cachedExternallyManaged = packageType !== null && !hasTrustedPackageManagerFor(packageType)
  }
  return cachedExternallyManaged
}
