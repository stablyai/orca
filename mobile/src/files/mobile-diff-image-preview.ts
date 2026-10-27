import { buildImageDataUri } from '../../../src/shared/image-data-uri'

// Only modifiedDeleted proves deletion; read failures can also return empty modifiedContent with modifiedIsBinary false.
// Omit kind: the reply reader admits every non-text arm, including unknown host arms.
export type MobileBinaryDiffResult = {
  kind?: string
  originalContent?: string
  modifiedContent?: string
  originalIsBinary?: boolean
  modifiedIsBinary?: boolean
  modifiedDeleted?: boolean
  isImage?: boolean
  mimeType?: string
}

// Use original bytes only for proven deletion; failed or size-capped reads must not show a stale image.
export function mobileDiffImageDataUri(result: MobileBinaryDiffResult): string | null {
  if (result.isImage !== true) {
    return null
  }
  const modified = result.modifiedContent || ''
  if (modified) {
    return buildImageDataUri(result.mimeType, modified)
  }
  if (result.modifiedDeleted === true) {
    return buildImageDataUri(result.mimeType, result.originalContent || '')
  }
  return null
}
