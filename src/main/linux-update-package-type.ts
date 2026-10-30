import { readFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { hasTrustedPackageManagerFor } from './linux-package-install-command'
import type { LinuxRootPackageType } from '../shared/update-status-types'

export type { LinuxRootPackageType }

export type LinuxPackageType = LinuxRootPackageType | 'non-root' | 'unusable'

let cachedPackageType: LinuxPackageType | undefined
let cachedExternallyManaged: boolean | undefined

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

/** Packaged Linux builds require a valid marker, except legacy AppImages with a missing marker. */
export function getLinuxPackageType(): LinuxPackageType {
  if (cachedPackageType === undefined) {
    cachedPackageType = readPackageTypeMarker()
  }
  return cachedPackageType
}

export function getLinuxRootPackageType(): LinuxRootPackageType | null {
  const packageType = getLinuxPackageType()
  return packageType === 'deb' || packageType === 'rpm' ? packageType : null
}

/** Repackagers can inherit deb/rpm markers; require the same manager discovery used for installation. */
export function isExternallyManagedLinuxInstall(): boolean {
  if (cachedExternallyManaged === undefined) {
    const packageType = getLinuxRootPackageType()
    cachedExternallyManaged = packageType !== null && !hasTrustedPackageManagerFor(packageType)
  }
  return cachedExternallyManaged
}
