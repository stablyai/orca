import { open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  AppImageRuntimeIdentity,
  AppImageRuntimeIdentityInput
} from './appimage-runtime-identity'

/** Async probing of an AppImage runtime root; same identity checks, no event-loop block. */

export const APPIMAGE_HEADER_LENGTH = 11
export const ORCA_PACKAGE_MARKER_MAX_BYTES = 1_024
export const PACKAGE_TYPE_MARKER_MAX_BYTES = 32

export function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') && isAbsolute(value)
}

export function isInside(rootPath: string, candidatePath: string): boolean {
  const candidateRelative = relative(rootPath, candidatePath)
  return (
    candidateRelative.length > 0 &&
    candidateRelative !== '..' &&
    !candidateRelative.startsWith(`..${sep}`) &&
    !isAbsolute(candidateRelative)
  )
}

async function readExactAsync(handle: FileHandle, length: number): Promise<Buffer | null> {
  const bytes = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await handle.read(bytes, offset, length - offset, offset)
    if (bytesRead === 0) {
      return null
    }
    offset += bytesRead
  }
  return bytes
}

async function inspectRegularFileAsync<T>(
  filePath: string,
  inspect: (handle: FileHandle) => Promise<T>
): Promise<T | null> {
  let handle: FileHandle | undefined
  try {
    handle = await open(filePath, 'r')
    if (!(await handle.stat()).isFile()) {
      return null
    }
    return await inspect(handle)
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {
      // Advisory cleanup must not override the verified inspection result.
    })
  }
}

async function hasAppImageHeaderAsync(appImagePath: string): Promise<boolean> {
  return (
    (await inspectRegularFileAsync(appImagePath, async (handle) => {
      const header = await readExactAsync(handle, APPIMAGE_HEADER_LENGTH)
      const stats = await handle.stat()
      return (
        (stats.mode & 0o111) !== 0 &&
        header?.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) === true &&
        header.subarray(8, 11).equals(Buffer.from([0x41, 0x49, 0x02]))
      )
    })) === true
  )
}

async function isExecutablePayloadFileAsync(
  runtimeRoot: string,
  filePath: string
): Promise<boolean> {
  try {
    const canonicalPath = await realpath(filePath)
    const stats = await stat(canonicalPath)
    return stats.isFile() && (stats.mode & 0o111) !== 0 && isInside(runtimeRoot, canonicalPath)
  } catch {
    return false
  }
}

async function readPayloadMarkerAsync(
  runtimeRoot: string,
  markerPath: string,
  maxBytes: number
): Promise<string | null> {
  try {
    const canonicalPath = await realpath(markerPath)
    if (!isInside(runtimeRoot, canonicalPath)) {
      return null
    }
    return await inspectRegularFileAsync(canonicalPath, async (handle) => {
      const stats = await handle.stat()
      if (stats.size === 0 || stats.size > maxBytes) {
        return null
      }
      return (await readExactAsync(handle, stats.size))?.toString('utf8') ?? null
    })
  } catch {
    return null
  }
}

async function hasAppImagePackageEvidenceAsync(
  runtimeRoot: string,
  resourcesPath: string
): Promise<boolean> {
  const packageType = await readPayloadMarkerAsync(
    runtimeRoot,
    join(resourcesPath, 'package-type'),
    PACKAGE_TYPE_MARKER_MAX_BYTES
  )
  if (packageType === 'AppImage') {
    return true
  }

  const content = await readPayloadMarkerAsync(
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

/** Async twin for main-thread callers; same identity checks, no event-loop block. */
export async function resolveAppImageRuntimeIdentityAsync(
  input: AppImageRuntimeIdentityInput = {}
): Promise<AppImageRuntimeIdentity | null> {
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
    !(await hasAppImageHeaderAsync(appImagePath))
  ) {
    return null
  }

  try {
    const realRuntimeRoot = await realpath(runtimeRoot)
    if (
      (await realpath(resourcesPath)) !== join(realRuntimeRoot, 'resources') ||
      !(await isExecutablePayloadFileAsync(realRuntimeRoot, execPath)) ||
      !(await isExecutablePayloadFileAsync(realRuntimeRoot, join(runtimeRoot, 'AppRun'))) ||
      !(await hasAppImagePackageEvidenceAsync(realRuntimeRoot, resourcesPath))
    ) {
      return null
    }
  } catch {
    return null
  }

  return { appImagePath }
}
