import { stat } from 'node:fs/promises'
import { BrowserError } from './browser-error'

/** Chromium attaches a missing path as an empty file, so check the paths before handing them over. */
export async function assertUploadFilesExist(filePaths: readonly string[]): Promise<void> {
  for (const filePath of filePaths) {
    // Directories stay allowed: webkitdirectory inputs take them.
    const exists = await stat(filePath).then(
      () => true,
      () => false
    )
    if (!exists) {
      throw new BrowserError('invalid_argument', `Cannot upload ${filePath}: it does not exist`)
    }
  }
}
