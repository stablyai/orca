import type { FileHandle } from 'node:fs/promises'
import type { FilePreview } from '../../shared/file-preview-kind'
import { rasterImageExceedsPreviewLimits } from '../../shared/raster-image-prefix-limits'
import { RASTER_IMAGE_PREVIEW_TOO_LARGE_ERROR } from '../../shared/raster-image-preview-limits'
import { MAX_PREVIEWABLE_BINARY_SIZE } from '../ipc/filesystem/filesystem-file-content-inspection'
import { fileTooLargeError } from '../ipc/filesystem/local-regular-file-read'
import type { RemoteFilePreviewAddress } from '../../shared/remote-file-preview-address'
import { readRemotePreviewRange } from './remote-file-preview-reader'

/** A URL preview keeps the base64 path's guard: an image whose header proves it oversized never reaches the decoder. */
export async function assertPreviewableRasterHeader(
  preview: FilePreview,
  readPrefix: (bytes: number) => Promise<Uint8Array>,
  size: number
): Promise<void> {
  if (preview.kind !== 'image') {
    return
  }
  // An <img> decodes the whole file, so images keep the base64 path's size cap; PDFs load by range.
  if (size > MAX_PREVIEWABLE_BINARY_SIZE) {
    throw fileTooLargeError(size, MAX_PREVIEWABLE_BINARY_SIZE)
  }
  if (await rasterImageExceedsPreviewLimits(readPrefix, preview.mimeType)) {
    throw new Error(RASTER_IMAGE_PREVIEW_TOO_LARGE_ERROR)
  }
}

/** A local file's first bytes for the check, read from the handle that serves it. */
export function localPrefixReader(handle: FileHandle, size: number) {
  return async (bytes: number): Promise<Uint8Array> => {
    const buffer = Buffer.alloc(Math.min(bytes, size))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  }
}

/** Grows one prefix and reads only its new tail, so each wider header probe costs only the new bytes. */
export function incrementalPrefixReader(
  readRange: (offset: number, length: number) => Promise<Uint8Array>
) {
  let prefix = new Uint8Array(0)
  let exhausted = false
  return async (bytes: number): Promise<Uint8Array> => {
    if (!exhausted && bytes > prefix.byteLength) {
      const tail = await readRange(prefix.byteLength, bytes - prefix.byteLength)
      const grown = new Uint8Array(prefix.byteLength + tail.byteLength)
      grown.set(prefix)
      grown.set(tail, prefix.byteLength)
      exhausted = tail.byteLength < bytes - prefix.byteLength
      prefix = grown
    }
    return prefix.subarray(0, Math.min(bytes, prefix.byteLength))
  }
}

/** The check against a local file, read from the handle that serves it. */
export function assertLocalPreviewRasterHeader(
  preview: FilePreview,
  handle: FileHandle,
  size: number
): Promise<void> {
  return assertPreviewableRasterHeader(preview, localPrefixReader(handle, size), size)
}

/** The check against a paired runtime's file, reading only each wider probe's new bytes. */
export function assertRemotePreviewRasterHeader(
  preview: FilePreview,
  address: RemoteFilePreviewAddress,
  size: number,
  signal: AbortSignal
): Promise<void> {
  return assertPreviewableRasterHeader(
    preview,
    incrementalPrefixReader((offset, length) =>
      readRemotePreviewRange(address, offset, length, size, signal)
    ),
    size
  )
}
