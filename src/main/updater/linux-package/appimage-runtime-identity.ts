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
import { access, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { appImageEphemeralRootOf } from '../../../shared/desktop-distribution/appimage/appimage-ephemeral-root'

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
      try {
        closeSync(fd)
      } catch {
        // Advisory cleanup must not override the verified inspection result.
      }
    }
  }
}

function hasAppImageHeader(appImagePath: string): boolean {
  return (
    inspectRegularFile(appImagePath, (fd, stats) => {
      return (stats.mode & 0o111) !== 0 && isAppImageHeader(readExact(fd, APPIMAGE_HEADER_LENGTH))
    }) === true
  )
}

function isAppImageHeader(header: Buffer | null): boolean {
  return (
    header?.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) === true &&
    header.subarray(8, 11).equals(Buffer.from([0x41, 0x49, 0x02]))
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

export function hasAppImagePathEnvironment(environment: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(environment.APPIMAGE)
}

function appImageRuntimePaths(input: AppImageRuntimeIdentityInput) {
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
    resolve(resourcesPath) !== resolve(join(runtimeRoot, 'resources'))
  ) {
    return null
  }
  return { appImagePath, runtimeRoot, execPath, resourcesPath }
}

export function isEphemeralAppImageRuntime(input: AppImageRuntimeIdentityInput = {}): boolean {
  if ((input.platform ?? process.platform) !== 'linux') {
    return false
  }
  const execPath = input.execPath ?? process.execPath
  const resourcesPath = input.resourcesPath ?? process.resourcesPath
  if (!isAbsolutePath(execPath) || !isAbsolutePath(resourcesPath)) {
    return false
  }
  const root = appImageEphemeralRootOf(execPath)
  return root?.path === dirname(execPath) && resourcesPath === join(root.path, 'resources')
}

export async function resolveAppImageRelaunchPath(
  input: AppImageRuntimeIdentityInput = {}
): Promise<string | null> {
  const paths = appImageRuntimePaths(input)
  if (!paths || appImageEphemeralRootOf(paths.execPath)?.path !== paths.runtimeRoot) {
    return null
  }
  try {
    const [artifact, runtimeRoot] = await Promise.all([
      realpath(paths.appImagePath),
      realpath(paths.runtimeRoot)
    ])
    if (artifact === runtimeRoot || isInside(runtimeRoot, artifact)) {
      return null
    }
    await access(artifact, constants.X_OK)
    const file = await open(artifact, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      if (!(await file.stat()).isFile()) {
        return null
      }
      const header = Buffer.alloc(APPIMAGE_HEADER_LENGTH)
      const { bytesRead } = await file.read(header, 0, header.length, 0)
      return bytesRead === header.length && isAppImageHeader(header) ? artifact : null
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

export function resolveAppImageRuntimeIdentity(
  input: AppImageRuntimeIdentityInput = {}
): AppImageRuntimeIdentity | null {
  const paths = appImageRuntimePaths(input)
  if (!paths || !hasAppImageHeader(paths.appImagePath)) {
    return null
  }
  const { appImagePath, runtimeRoot, execPath, resourcesPath } = paths

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
