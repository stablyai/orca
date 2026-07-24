import { dialog } from 'electron'
import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import {
  NodeFileReadTooLargeError,
  readNodeFileWithinLimit
} from '../../shared/node-bounded-file-reader'
import { assertRasterImagePreviewWithinLimits } from '../../shared/raster-image-preview-limits'
import { MAX_REPO_ICON_UPLOAD_BYTES } from '../../shared/repo-icon'

const REPO_ICON_IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png'
}

export async function pickRepoIconImage(): Promise<{
  dataUrl: string
  fileName: string
} | null> {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Repo icon images', extensions: ['png'] }]
  })
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }

  const filePath = result.filePaths[0]
  const mimeType = REPO_ICON_IMAGE_MIME_TYPES[extname(filePath).toLowerCase()]
  if (!mimeType) {
    throw new Error('Repo icons must be PNG files.')
  }

  const stats = await stat(filePath)
  if (stats.size > MAX_REPO_ICON_UPLOAD_BYTES) {
    throw new Error('Repo icon image must be 256KB or smaller.')
  }

  let buffer: Buffer
  try {
    buffer = (await readNodeFileWithinLimit(filePath, MAX_REPO_ICON_UPLOAD_BYTES)).buffer
  } catch (error) {
    if (error instanceof NodeFileReadTooLargeError) {
      throw new Error('Repo icon image must be 256KB or smaller.')
    }
    throw error
  }
  assertRasterImagePreviewWithinLimits(buffer, mimeType)
  return {
    dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
    fileName: basename(filePath)
  }
}
