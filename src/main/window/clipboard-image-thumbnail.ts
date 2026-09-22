import {
  assertClipboardImageDimensionsWithinLimit,
  clipboardImageThumbnailSize,
  type ClipboardImageDimensions,
  type ClipboardImageThumbnail
} from '../../shared/clipboard-image'

/** The slice of Electron's NativeImage this module needs, so the decision logic
 *  is testable without an Electron runtime. */
export type ClipboardImageLike = {
  isEmpty: () => boolean
  getSize: () => ClipboardImageDimensions
  resize: (options: { height: number; width: number; quality: 'good' | 'better' | 'best' }) => {
    toDataURL: () => string
  }
  toDataURL: () => string
}

/**
 * In-memory preview of whatever image the clipboard holds. Writing the image to
 * disk (or uploading it over SFTP) takes long enough that a composer with no
 * feedback reads as a dropped paste, so this answers "is there an image, and
 * what does it look like" without touching the filesystem.
 */
export function buildClipboardImageThumbnail(
  image: ClipboardImageLike
): ClipboardImageThumbnail | null {
  if (image.isEmpty()) {
    return null
  }
  const size = image.getSize()
  try {
    assertClipboardImageDimensionsWithinLimit(size)
  } catch {
    // Oversized images still report through the save call; the probe only
    // decides whether to show a placeholder, so degrade to "no preview".
    return null
  }
  const thumbnailSize = clipboardImageThumbnailSize(size)
  const thumbnail =
    thumbnailSize.width === size.width && thumbnailSize.height === size.height
      ? image
      : image.resize({ ...thumbnailSize, quality: 'good' })
  return { dataUrl: thumbnail.toDataURL(), height: size.height, width: size.width }
}
