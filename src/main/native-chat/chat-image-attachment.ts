import { open } from 'node:fs/promises'
import { extname } from 'node:path'

// Every provider lane buffers an attached image and base64-encodes it in the main process, so an
// unbounded read costs two copies of the file before anything can reject it.
export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_CHAT_IMAGE_COUNT = 20
export const MAX_CHAT_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024

const MIME_BY_EXTENSION: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
}

export function chatImageMimeType(path: string): string | undefined {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()]
}

/**
 * Read an image attachment under `MAX_CHAT_IMAGE_BYTES`. `label` names the subject in the
 * rejection messages ("Claude image", "ACP image").
 */
export async function readBoundedChatImage(
  path: string,
  label: string,
  openImpl: typeof open = open
): Promise<Buffer> {
  const file = await openImpl(path, 'r')
  try {
    const invalidImage = (): Error =>
      new Error(`${label} must be a non-empty file no larger than ${MAX_CHAT_IMAGE_BYTES} bytes`)
    const info = await file.stat()
    if (!info.isFile()) {
      throw new Error(`${label} must be a file`)
    }
    if (info.size > MAX_CHAT_IMAGE_BYTES) {
      throw invalidImage()
    }
    const buffer = Buffer.allocUnsafe(info.size + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (result.bytesRead === 0) {
        break
      }
      bytesRead += result.bytesRead
    }
    // A file can grow after the initial stat and after the final read returns
    // zero. Prove the descriptor's size matches what was copied before sending.
    const finalInfo = await file.stat()
    if (bytesRead === 0 || bytesRead > MAX_CHAT_IMAGE_BYTES || finalInfo.size !== bytesRead) {
      throw invalidImage()
    }
    return buffer.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}
