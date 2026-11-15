import { stat } from 'node:fs/promises'
import {
  filePreviewExtension,
  filePreviewForPath
} from '../../../../shared/file-preview/file-preview-kind'
import { openLocalRegularFile, readImageFileSignature } from '../local-regular-file-read'
import { windowsFsPath } from '../../../wsl/filesystem/wsl-unc-drive-fs-path'

/** Chat draws images only (PDFs need another surface); Telegram's `.jpg` links lead to extensionless files, so those count by their bytes. */
export async function isChatImageTarget(filePath: string): Promise<boolean> {
  if (filePreviewForPath(filePath)?.kind === 'image') {
    return true
  }
  if (filePreviewExtension(filePath) !== '') {
    return false
  }
  // Devices are extensionless, and opening one (a serial port) can act on it.
  if (!(await stat(windowsFsPath(filePath))).isFile()) {
    return false
  }
  const { handle } = await openLocalRegularFile(filePath)
  try {
    return (await readImageFileSignature(handle)) !== null
  } finally {
    await handle.close()
  }
}
