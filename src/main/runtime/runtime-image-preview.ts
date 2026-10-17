import type { RuntimeFilePreviewResult } from '../../shared/runtime-types'
import { assertRasterImagePreviewWithinLimits } from '../../shared/raster-image-preview-limits'
import {
  LOCAL_PREVIEWABLE_BINARY_MAX_BYTES,
  assertPreviewWithinTransportBudget,
  previewableBinaryByteLimit
} from './files/file-preview-budget'

// pngjs uses the last IHDR and unbounded inflation for interlaced PNGs. Validate
// the complete chunk layout before allowing its decoder to allocate memory.
function assertTransformableImage(bytes: Buffer, mimeType: string): void {
  if (mimeType === 'image/jpeg') {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error('Invalid JPEG')
    return
  }
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('Invalid PNG')
  }
  let headerSeen = false
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > bytes.length) throw new Error('Invalid PNG chunk')
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    if (!headerSeen && type !== 'IHDR') throw new Error('Missing PNG header')
    if (type === 'IHDR') {
      if (headerSeen || length !== 13 || bytes[offset + 20] !== 0)
        throw new Error('Unsupported PNG header')
      headerSeen = true
    }
    if (type === 'acTL') throw new Error('Animated PNG')
    offset = end
    if (type === 'IEND') {
      if (length !== 0 || offset !== bytes.length) throw new Error('Invalid PNG end')
      return
    }
  }
  throw new Error('Incomplete PNG')
}

export function imagePreviewReadLimit(mimeType: string | undefined, budget?: number): number {
  if (budget !== undefined && budget < 256) return previewableBinaryByteLimit(budget)
  if (budget === undefined || mimeType === 'image/png' || mimeType === 'image/jpeg') {
    return LOCAL_PREVIEWABLE_BINARY_MAX_BYTES
  }
  return previewableBinaryByteLimit(budget)
}

export async function buildRuntimeImagePreview(
  bytes: Buffer,
  mimeType: string,
  budget?: number
): Promise<RuntimeFilePreviewResult> {
  const result = { content: bytes.toString('base64'), isBinary: true, isImage: true, mimeType }
  if (budget === undefined || bytes.length <= previewableBinaryByteLimit(budget)) {
    return assertPreviewWithinTransportBudget(result, budget)
  }
  if (
    bytes.length > LOCAL_PREVIEWABLE_BINARY_MAX_BYTES ||
    budget < 256 ||
    (mimeType !== 'image/png' && mimeType !== 'image/jpeg')
  ) {
    throw new Error('file_too_large')
  }
  try {
    assertTransformableImage(bytes, mimeType)
    assertRasterImagePreviewWithinLimits(bytes, mimeType)
    const { shrinkImagePreviewInWorker } = await import('./runtime-image-preview-worker')
    const preview = await shrinkImagePreviewInWorker(bytes, previewableBinaryByteLimit(budget))
    return assertPreviewWithinTransportBudget(
      {
        content: preview.bytes.toString('base64'),
        isBinary: true,
        isImage: true,
        mimeType: preview.mimeType
      },
      budget
    )
  } catch {
    throw new Error('file_too_large')
  }
}
