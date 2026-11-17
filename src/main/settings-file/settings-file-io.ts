import { constants } from 'node:fs'
import { access, lstat, mkdir, open, realpath, readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { durableWriteTempPath, writeFileDurable } from '../filesystem/durable-file-write'

export type SettingsFileRead =
  | { kind: 'missing' }
  | { kind: 'read'; text: string; realPath: string }
export type SettingsFileWrite =
  | { kind: 'written' }
  | { kind: 'missing' }
  | { kind: 'read-only' }
  | { kind: 'busy' }
export type SettingsFileCreate = { kind: 'created' } | { kind: 'exists' } | { kind: 'read-only' }

const READ_ONLY_CODES = new Set(['EACCES', 'EROFS', 'EPERM', 'EBUSY', 'EXDEV'])
const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR'])
// Windows reports a file briefly held by an editor or antivirus scan as EPERM/EBUSY.
const WINDOWS_TRANSIENT_WRITE_CODES = new Set(['EPERM', 'EBUSY'])

export const DANGLING_LINK_MESSAGE = 'The settings file link points to a missing file'

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

function hasCode(error: unknown, codes: ReadonlySet<string>): boolean {
  const code = errorCode(error)
  return code !== undefined && codes.has(code)
}

export function isTransientWriteFailure(
  error: unknown,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'win32' && hasCode(error, WINDOWS_TRANSIENT_WRITE_CODES)
}

async function pathIsDanglingLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink()
  } catch {
    return false
  }
}

export async function readSettingsFile(path: string): Promise<SettingsFileRead> {
  try {
    const realPath = await realpath(path)
    return { kind: 'read', text: await readFile(realPath, 'utf-8'), realPath }
  } catch (error) {
    if (hasCode(error, MISSING_CODES)) {
      if (await pathIsDanglingLink(path)) {
        throw new Error(DANGLING_LINK_MESSAGE)
      }
      return { kind: 'missing' }
    }
    throw error
  }
}

// Writes through symlinks so a linked settings.json stays a link; never creates a missing file.
export async function writeSettingsFile(path: string, text: string): Promise<SettingsFileWrite> {
  try {
    const realPath = await realpath(path)
    // A read-only file would otherwise be silently replaced by the rename.
    await access(realPath, constants.W_OK)
    const { mode } = await stat(realPath)
    await writeFileDurable(durableWriteTempPath(realPath), realPath, text, mode & 0o777)
    return { kind: 'written' }
  } catch (error) {
    if (hasCode(error, MISSING_CODES)) {
      return { kind: 'missing' }
    }
    if (isTransientWriteFailure(error)) {
      return { kind: 'busy' }
    }
    if (hasCode(error, READ_ONLY_CODES)) {
      return { kind: 'read-only' }
    }
    throw error
  }
}

export async function createSettingsFile(path: string, text: string): Promise<SettingsFileCreate> {
  try {
    await mkdir(dirname(path), { recursive: true })
    const handle = await open(path, 'wx')
    try {
      await handle.writeFile(text, 'utf-8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    return { kind: 'created' }
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      return { kind: 'exists' }
    }
    if (hasCode(error, READ_ONLY_CODES)) {
      return { kind: 'read-only' }
    }
    throw error
  }
}
