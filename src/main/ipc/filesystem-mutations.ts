import { ipcMain } from 'electron'
import { lstat, mkdir, rename, writeFile } from 'fs/promises'
import { basename, dirname } from 'path'
import type { Store } from '../persistence'
import { resolveAuthorizedPath, isENOENT } from './filesystem-auth'

/**
 * Re-throw filesystem errors with user-friendly messages.
 * The `wx` flag on writeFile throws a raw EEXIST with no helpful message,
 * so we catch it here and provide context the renderer can display directly.
 */
function rethrowWithUserMessage(error: unknown, targetPath: string): never {
  const name = basename(targetPath)
  if (error instanceof Error && 'code' in error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') {
      throw new Error(`A file or folder named '${name}' already exists in this location`)
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(`Permission denied: unable to create '${name}'`)
    }
  }
  throw error
}

/**
 * Ensure `targetPath` does not already exist. Throws if it does.
 *
 * Note: this is a non-atomic check — a concurrent operation could create the
 * path between `lstat` and the caller's next action. Acceptable for a desktop
 * app with low concurrency; `createFile` uses the `wx` flag for an atomic
 * alternative where possible.
 */
async function assertNotExists(targetPath: string): Promise<void> {
  try {
    await lstat(targetPath)
    throw new Error(
      `A file or folder named '${basename(targetPath)}' already exists in this location`
    )
  } catch (error) {
    if (!isENOENT(error)) {
      throw error
    }
  }
}

/**
 * IPC handlers for file/folder creation and renaming.
 * Deletion is handled separately via `fs:deletePath` (shell.trashItem).
 */
export function registerFilesystemMutationHandlers(store: Store): void {
  ipcMain.handle('fs:createFile', async (_event, args: { filePath: string }): Promise<void> => {
    const filePath = await resolveAuthorizedPath(args.filePath, store)
    await mkdir(dirname(filePath), { recursive: true })
    try {
      // Use the 'wx' flag for atomic create-if-not-exists, avoiding TOCTOU races
      await writeFile(filePath, '', { encoding: 'utf-8', flag: 'wx' })
    } catch (error) {
      rethrowWithUserMessage(error, filePath)
    }
  })

  ipcMain.handle('fs:createDir', async (_event, args: { dirPath: string }): Promise<void> => {
    const dirPath = await resolveAuthorizedPath(args.dirPath, store)
    await assertNotExists(dirPath)
    await mkdir(dirPath, { recursive: true })
  })

  // Note: fs.rename throws EXDEV if old and new paths are on different
  // filesystems/volumes. This is unlikely since both paths are under the same
  // workspace root, but a cross-drive rename would surface as an IPC error.
  ipcMain.handle(
    'fs:rename',
    async (_event, args: { oldPath: string; newPath: string }): Promise<void> => {
      const oldPath = await resolveAuthorizedPath(args.oldPath, store)
      const newPath = await resolveAuthorizedPath(args.newPath, store)
      await assertNotExists(newPath)
      await rename(oldPath, newPath)
    }
  )
}
