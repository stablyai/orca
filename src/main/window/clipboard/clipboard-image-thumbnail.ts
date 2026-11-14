import {
  clipboardImageThumbnailSize,
  type ClipboardImageDimensions,
  type ClipboardImageThumbnail
} from '../../../shared/clipboard-image'

/** Minimal NativeImage surface for tests without an Electron runtime. */
export type ClipboardImageLike = {
  isEmpty: () => boolean
  getSize: () => ClipboardImageDimensions
  resize: (options: { height: number; width: number; quality: 'good' | 'better' | 'best' }) => {
    toDataURL: () => string
  }
  toDataURL: () => string
}

/** Preview in memory before slower disk/SFTP saving so composer paste gets immediate feedback. */
export function buildClipboardImageThumbnail(
  image: ClipboardImageLike
): ClipboardImageThumbnail | null {
  if (image.isEmpty()) {
    return null
  }
  const size = image.getSize()
  // Already decoded, and the save downscales oversized images, so only reject degenerate sizes.
  if (!(size.width > 0 && size.height > 0)) {
    return null
  }
  const thumbnailSize = clipboardImageThumbnailSize(size)
  const thumbnail =
    thumbnailSize.width === size.width && thumbnailSize.height === size.height
      ? image
      : image.resize({ ...thumbnailSize, quality: 'good' })
  return { dataUrl: thumbnail.toDataURL(), height: size.height, width: size.width }
}
