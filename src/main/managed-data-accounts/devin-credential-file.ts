import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { renameFileWithWindowsRetryAsync } from '../../shared/windows-retry-file-operations'
import {
  restrictWindowsDirectory,
  restrictWindowsFile
} from '../../shared/secure-storage/secure-path-windows-acl'

const UNSUPPORTED_DIRECTORY_FSYNC_CODES = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'])
const directoryHardening = new Map<string, Promise<boolean>>()

async function restrictWindowsDirectoryOnce(directory: string): Promise<boolean> {
  const pending = directoryHardening.get(directory)
  if (pending) {
    return pending
  }
  const hardening = restrictWindowsDirectory(directory).then(
    (restricted) => {
      if (!restricted) {
        directoryHardening.delete(directory)
      }
      return restricted
    },
    (error: unknown) => {
      directoryHardening.delete(directory)
      throw error
    }
  )
  directoryHardening.set(directory, hardening)
  return hardening
}

/** Writes a user-only credential through an atomic rename without blocking the main thread. */
export async function writeDevinCredentialFile(
  targetPath: string,
  contents: string,
  durable = true
): Promise<boolean> {
  const directory = dirname(targetPath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const restrictedDirectory =
    process.platform === 'win32'
      ? await restrictWindowsDirectoryOnce(directory)
      : (await chmod(directory, 0o700), true)
  if (!restrictedDirectory) {
    return false
  }

  const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
  let published = false
  try {
    const file = await open(tempPath, 'wx', 0o600)
    try {
      await file.writeFile(contents, 'utf8')
      if (durable) {
        await file.sync()
      }
    } finally {
      await file.close()
    }

    const restrictedFile =
      process.platform === 'win32'
        ? await restrictWindowsFile(tempPath)
        : (await chmod(tempPath, 0o600), true)
    if (!restrictedFile) {
      return false
    }
    if (!(await renameFileWithWindowsRetryAsync(tempPath, targetPath))) {
      return false
    }
    published = true
    if (durable && process.platform !== 'win32') {
      await syncDirectory(directory)
    }
    return true
  } finally {
    if (!published) {
      await rm(tempPath, { force: true }).catch(() => {})
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (typeof code === 'string' && UNSUPPORTED_DIRECTORY_FSYNC_CODES.has(code)) {
      return
    }
    throw error
  } finally {
    await handle?.close().catch(() => {})
  }
}
