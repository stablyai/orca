import type { NativeImage } from 'electron'
import { encodeClipboardImageWithinLimit } from '../../../shared/clipboard/clipboard-image'
import { detectImageFileSignature } from '../../../shared/file-content/image-file-signature'

export function encodeClipboardNativeImagePng(
  image: Pick<NativeImage, 'getSize' | 'resize' | 'toPNG'>
): Promise<Buffer> {
  const source = image.getSize()
  return encodeClipboardImageWithinLimit(
    source,
    (size) =>
      size.width === source.width && size.height === source.height
        ? image.toPNG()
        : image.resize({ ...size, quality: 'best' }).toPNG(),
    (png) => png.byteLength
  )
}

/** Decoded PNG bytes are already publishable; re-encoding them adds an image-sized pass on main. */
export function clipboardImagePngBytes(source: Buffer, image: Pick<NativeImage, 'toPNG'>): Buffer {
  return detectImageFileSignature(source)?.mimeType === 'image/png' ? source : image.toPNG()
}
