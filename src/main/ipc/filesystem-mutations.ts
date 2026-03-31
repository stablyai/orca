import { ipcMain } from 'electron'
import { lstat, mkdir, rename, writeFile } from 'fs/promises'
import { dirname } from 'path'
import type { Store } from '../persistence'
import { resolveAuthorizedPath, isENOENT } from './filesystem-auth'

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
    throw new Error('A file or folder already exists at this path')
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
    // Use the 'wx' flag for atomic create-if-not-exists, avoiding TOCTOU races
    await writeFile(filePath, '', { encoding: 'utf-8', flag: 'wx' })
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
