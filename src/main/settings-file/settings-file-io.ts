import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { access, lstat, mkdir, open, realpath, readFile, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  durableWriteTempPath,
  renameDurable,
  writeTempFileDurable
} from '../filesystem/durable-file-write'

export type SettingsFileRead =
  | { kind: 'missing' }
  | { kind: 'read'; text: string; realPath: string }
export type SettingsFileWrite =
  | { kind: 'written' }
  | { kind: 'changed' }
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
// Returns `changed` instead of replacing a file that no longer holds `expectedText`.
export async function writeSettingsFile(
  path: string,
  text: string,
  expectedText: string
): Promise<SettingsFileWrite> {
  let tmpPath: string | null = null
  try {
    const realPath = await realpath(path)
    // A read-only file would otherwise be silently replaced by the rename.
    await access(realPath, constants.W_OK)
    const { mode } = await stat(realPath)
    tmpPath = durableWriteTempPath(realPath)
    await writeTempFileDurable(tmpPath, text, mode & 0o777)
    // Re-check last, so an external edit landing during the temp write is not overwritten.
    if (
      (await realpath(path)) !== realPath ||
      (await readFile(realPath, 'utf-8')) !== expectedText
    ) {
      return { kind: 'changed' }
    }
    await renameDurable(tmpPath, realPath)
    tmpPath = null
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
  } finally {
    if (tmpPath !== null) {
      await rm(tmpPath, { force: true }).catch(() => {})
    }
  }
}

// Removes a file this attempt created unless something else has replaced it since.
async function removeIfSameFile(path: string, created: Stats): Promise<void> {
  const current = await lstat(path).catch(() => null)
  if (current && current.dev === created.dev && current.ino === created.ino) {
    await rm(path, { force: true }).catch(() => {})
  }
}

export async function createSettingsFile(path: string, text: string): Promise<SettingsFileCreate> {
  try {
    await mkdir(dirname(path), { recursive: true })
    const handle = await open(path, 'wx')
    let written = false
    try {
      await handle.writeFile(text, 'utf-8')
      await handle.sync()
      written = true
    } finally {
      // A partial file left behind would make every retry report `exists`.
      const created = written ? null : await handle.stat().catch(() => null)
      await handle.close()
      if (created) {
        await removeIfSameFile(path, created)
      }
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
