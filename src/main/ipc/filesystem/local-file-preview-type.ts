import type { FileHandle } from 'node:fs/promises'
import { filePreviewExtension, previewableBinaryMimeType } from '../../../shared/file-preview-kind'
import { IMAGE_SIGNATURE_BYTES } from '../../../shared/image-file-signature'
import { openLocalRegularFile, readLocalFilePrefix } from './local-regular-file-read'

export async function readLocalPreviewMimeType(
  filePath: string,
  handle?: FileHandle
): Promise<string | undefined> {
  const mimeType = previewableBinaryMimeType(filePath)
  if (mimeType) {
    return mimeType
  }
  if (filePreviewExtension(filePath)) {
    return undefined
  }
  const previewHandle = handle ?? (await openLocalRegularFile(filePath)).handle
  try {
    return previewableBinaryMimeType(
      filePath,
      await readLocalFilePrefix(previewHandle, IMAGE_SIGNATURE_BYTES)
    )
  } finally {
    if (!handle) {
      await previewHandle.close()
    }
  }
}
