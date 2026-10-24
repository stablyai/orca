import { extname } from 'node:path'
import { localLogFileIdentity } from '../../ai-vault/local-log-tail-reader'
import { BINARY_PROBE_BYTES, isBinaryBuffer } from '../../../shared/binary-buffer'
import {
  fileTooLargeError,
  openLocalRegularFile,
  readLocalFileBounded,
  readLocalFilePrefix
} from './local-regular-file-read'

// Monaco degrades features on large files; a 5MB cap would reject ordinary logs and JSON.
export const MAX_TEXT_FILE_SIZE = 50 * 1024 * 1024
export const MAX_PREVIEWABLE_BINARY_SIZE = 50 * 1024 * 1024
export const PREVIEWABLE_BINARY_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.avif': 'image/avif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf'
}

export type LocalFileContent = {
  mediaUrl?: string
  content: string
  isBinary: boolean
  isImage?: boolean
  mimeType?: string
  fileIdentity?: string
}

/** One open, one handle: the size check, binary probe and read all see the same regular file. */
export async function readLocalFileContent(filePath: string): Promise<LocalFileContent> {
  const { handle, stats } = await openLocalRegularFile(filePath)
  try {
    const mimeType = PREVIEWABLE_BINARY_MIME_TYPES[extname(filePath).toLowerCase()]
    const sizeLimit = mimeType ? MAX_PREVIEWABLE_BINARY_SIZE : MAX_TEXT_FILE_SIZE
    if (stats.size > sizeLimit) {
      throw fileTooLargeError(stats.size, sizeLimit)
    }
    if (mimeType) {
      const buffer = await readLocalFileBounded(handle, sizeLimit, stats.size)
      return {
        content: buffer.toString('base64'),
        isBinary: true,
        // Existing renderer preview selection uses isImage for PDFs as well.
        isImage: true,
        mimeType
      }
    }
    // Probe large unknown binaries before allocating their whole body.
    if (
      stats.size > BINARY_PROBE_BYTES &&
      isBinaryBuffer(await readLocalFilePrefix(handle, BINARY_PROBE_BYTES))
    ) {
      return { content: '', isBinary: true }
    }
    const buffer = await readLocalFileBounded(handle, sizeLimit, stats.size)
    if (isBinaryBuffer(buffer)) {
      return { content: '', isBinary: true }
    }
    return { content: buffer.toString('utf-8'), isBinary: false }
  } finally {
    await handle.close()
  }
}

export async function readLocalLogSnapshot(filePath: string): Promise<LocalFileContent> {
  const { handle, stats } = await openLocalRegularFile(filePath)
  try {
    if (stats.size > MAX_TEXT_FILE_SIZE) {
      throw fileTooLargeError(stats.size, MAX_TEXT_FILE_SIZE)
    }
    const buffer = await readLocalFileBounded(handle, MAX_TEXT_FILE_SIZE, stats.size)
    if (isBinaryBuffer(buffer)) {
      return { content: '', isBinary: true }
    }
    return {
      content: buffer.toString('utf8'),
      isBinary: false,
      fileIdentity: localLogFileIdentity(stats)
    }
  } finally {
    await handle.close()
  }
}
