import type { NativeImage } from 'electron'
import { encodeClipboardImageWithinLimit } from '../../shared/clipboard-image'

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
