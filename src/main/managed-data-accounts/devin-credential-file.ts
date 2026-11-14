import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { renameFileWithWindowsRetryAsync } from '../../shared/windows-retry-file-operations'
import {
  restrictWindowsDirectory,
  restrictWindowsFile
} from '../../shared/secure-storage/secure-path-windows-acl'

// Why: async counterpart of writeSecureFile; the main process may not block on fs.
async function restrictToUser(path: string, isDirectory: boolean): Promise<boolean> {
  if (process.platform === 'win32') {
    return isDirectory ? restrictWindowsDirectory(path) : restrictWindowsFile(path)
  }
  await chmod(path, isDirectory ? 0o700 : 0o600)
  return true
}

/** Writes a user-only credential through an atomic rename. */
export async function writeDevinCredentialFile(
  targetPath: string,
  contents: string
): Promise<boolean> {
  const directory = dirname(targetPath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (!(await restrictToUser(directory, true))) {
    return false
  }

  const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
  let published = false
  try {
    const file = await open(tempPath, 'wx', 0o600)
    try {
      await file.writeFile(contents, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    if (!(await restrictToUser(tempPath, false))) {
      return false
    }
    published = await renameFileWithWindowsRetryAsync(tempPath, targetPath)
    return published
  } finally {
    if (!published) {
      await rm(tempPath, { force: true }).catch(() => {})
    }
  }
}
