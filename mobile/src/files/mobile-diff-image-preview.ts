import { buildImageDataUri } from '../../../src/shared/image-data-uri'

// modifiedDeleted marks a proven deletion (modified side genuinely absent); an
// empty modifiedContent alone can't, since a relay/SSH read failure also arrives
// empty with modifiedIsBinary false.
// Kind is not named here: the reply reader admits any arm but `text`, so a host arm this build has
// not heard of reaches the same projection main's `kind !== 'text'` sent it to.
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

// Falls back to the original bytes only for a proven deletion; a read failure or
// size-capped modify — also empty on the modified side — returns null instead of
// the stale pre-change image.
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
