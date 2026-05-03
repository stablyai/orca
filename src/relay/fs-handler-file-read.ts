import { readFile, stat } from 'fs/promises'
import { extname } from 'path'
import {
  BINARY_PROBE_BYTES,
  IMAGE_MIME_TYPES,
  MAX_PREVIEWABLE_BINARY_SIZE,
  MAX_TEXT_FILE_SIZE,
  isBinaryBuffer,
  isBinaryFilePrefix
} from './fs-handler-utils'

export async function readRelayFileContent(filePath: string) {
  const stats = await stat(filePath)
  const mimeType = IMAGE_MIME_TYPES[extname(filePath).toLowerCase()]
  const sizeLimit = mimeType ? MAX_PREVIEWABLE_BINARY_SIZE : MAX_TEXT_FILE_SIZE
  if (stats.size > sizeLimit) {
    throw new Error(
      `File too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB exceeds ${sizeLimit / 1024 / 1024}MB limit`
    )
  }

  if (mimeType) {
    const buffer = await readFile(filePath)
    return { content: buffer.toString('base64'), isBinary: true, isImage: true, mimeType }
  }

  // Why: SSH reads serialize through bounded relay frames; probing large
  // unknown files prevents binary archives from consuming frame budget.
  if (stats.size > BINARY_PROBE_BYTES && (await isBinaryFilePrefix(filePath))) {
    return { content: '', isBinary: true }
  }

  const buffer = await readFile(filePath)
  if (isBinaryBuffer(buffer)) {
    return { content: '', isBinary: true }
  }
  return { content: buffer.toString('utf-8'), isBinary: false }
}
