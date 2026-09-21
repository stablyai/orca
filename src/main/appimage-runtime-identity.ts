import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  type Stats
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const APPIMAGE_HEADER_LENGTH = 11
const ORCA_PACKAGE_MARKER_MAX_BYTES = 1_024
const PACKAGE_TYPE_MARKER_MAX_BYTES = 32

export type AppImageRuntimeIdentity = {
  appImagePath: string
}

export type AppImageRuntimeIdentityInput = {
  platform?: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
  execPath?: unknown
  resourcesPath?: unknown
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') && isAbsolute(value)
}

function readExact(fd: number, length: number): Buffer | null {
  const bytes = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const count = readSync(fd, bytes, offset, length - offset, offset)
    if (count === 0) {
      return null
    }
    offset += count
  }
  return bytes
}

function inspectRegularFile<T>(
  filePath: string,
  inspect: (fd: number, stats: Stats) => T
): T | null {
  let fd: number | undefined
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NONBLOCK)
    const stats = fstatSync(fd)
    return stats.isFile() ? inspect(fd, stats) : null
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}

function hasAppImageHeader(appImagePath: string): boolean {
  return (
    inspectRegularFile(appImagePath, (fd, stats) => {
      const header = readExact(fd, APPIMAGE_HEADER_LENGTH)
      return (
        (stats.mode & 0o111) !== 0 &&
        header?.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) === true &&
        header.subarray(8, 11).equals(Buffer.from([0x41, 0x49, 0x02]))
      )
    }) === true
  )
}

function isInside(rootPath: string, candidatePath: string): boolean {
  const candidateRelative = relative(rootPath, candidatePath)
  return (
    candidateRelative.length > 0 &&
    candidateRelative !== '..' &&
    !candidateRelative.startsWith(`..${sep}`) &&
    !isAbsolute(candidateRelative)
  )
}

function isExecutablePayloadFile(runtimeRoot: string, filePath: string): boolean {
  try {
    const canonicalPath = realpathSync(filePath)
    const stats = statSync(canonicalPath)
    return stats.isFile() && (stats.mode & 0o111) !== 0 && isInside(runtimeRoot, canonicalPath)
  } catch {
    return false
  }
}

function readPayloadMarker(
  runtimeRoot: string,
  markerPath: string,
  maxBytes: number
): string | null {
  try {
    const canonicalPath = realpathSync(markerPath)
    if (!isInside(runtimeRoot, canonicalPath)) {
      return null
    }
    return inspectRegularFile(canonicalPath, (fd, stats) =>
      stats.size === 0 || stats.size > maxBytes
        ? null
        : (readExact(fd, stats.size)?.toString('utf8') ?? null)
    )
  } catch {
    return null
  }
}

function hasAppImagePackageEvidence(runtimeRoot: string, resourcesPath: string): boolean {
  const packageType = readPayloadMarker(
    runtimeRoot,
    join(resourcesPath, 'package-type'),
    PACKAGE_TYPE_MARKER_MAX_BYTES
  )
  if (packageType === 'AppImage') {
    return true
  }

  const content = readPayloadMarker(
    runtimeRoot,
    join(resourcesPath, 'app.asar.unpacked', 'out', 'package.json'),
    ORCA_PACKAGE_MARKER_MAX_BYTES
  )
  try {
    const marker: unknown = JSON.parse(content ?? '')
    return (
      typeof marker === 'object' &&
      marker !== null &&
      'name' in marker &&
      marker.name === 'orca-compiled-output' &&
      'type' in marker &&
      marker.type === 'commonjs'
    )
  } catch {
    return false
  }
}

/** Returns whether the process inherited an AppImage file path to validate. */
export function hasAppImagePathEnvironment(environment: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(environment.APPIMAGE)
}

export function resolveAppImageRuntimeIdentity(
  input: AppImageRuntimeIdentityInput = {}
): AppImageRuntimeIdentity | null {
  if ((input.platform ?? process.platform) !== 'linux') {
    return null
  }

  const environment = input.environment ?? process.env
  const appImagePath = environment.APPIMAGE
  const appDirPath = environment.APPDIR
  const execPath = input.execPath ?? process.execPath
  const resourcesPath = input.resourcesPath ?? process.resourcesPath
  if (
    !isAbsolutePath(appImagePath) ||
    !isAbsolutePath(appDirPath) ||
    !isAbsolutePath(execPath) ||
    !isAbsolutePath(resourcesPath)
  ) {
    return null
  }

  const runtimeRoot = resolve(appDirPath)
  if (
    resolve(dirname(execPath)) !== runtimeRoot ||
    resolve(resourcesPath) !== resolve(join(runtimeRoot, 'resources')) ||
    !hasAppImageHeader(appImagePath)
  ) {
    return null
  }

  try {
    const realRuntimeRoot = realpathSync(runtimeRoot)
    if (
      realpathSync(resourcesPath) !== join(realRuntimeRoot, 'resources') ||
      !isExecutablePayloadFile(realRuntimeRoot, execPath) ||
      !isExecutablePayloadFile(realRuntimeRoot, join(runtimeRoot, 'AppRun')) ||
      !hasAppImagePackageEvidence(realRuntimeRoot, resourcesPath)
    ) {
      return null
    }
  } catch {
    return null
  }

  return { appImagePath }
}
