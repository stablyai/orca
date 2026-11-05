import {
  prepareMobileClipboardImageBase64,
  type MobileClipboardImage
} from '../../mobile-clipboard-image'
import { resizeMobileClipboardImage } from '../../mobile-clipboard-image-resize'
import type { MobileComposerPastedImage } from './mobile-native-chat-composer-image-paste'

const DATA_URL_PREFIX_RE = /^data:image\/[a-z0-9.+-]+;base64,/i

async function pastedImageSize(source: string): Promise<{ width: number; height: number }> {
  const image = new Image()
  image.src = DATA_URL_PREFIX_RE.test(source) ? source : `data:image/png;base64,${source}`
  try {
    await image.decode()
  } catch {
    return { width: 0, height: 0 }
  }
  return { width: image.naturalWidth, height: image.naturalHeight }
}

async function prepareOne(image: MobileComposerPastedImage): Promise<MobileComposerPastedImage> {
  const size = await pastedImageSize(image.uri ?? image.base64)
  const clipboardImage: MobileClipboardImage = { data: image.base64, size }
  const prepared = await prepareMobileClipboardImageBase64(
    clipboardImage,
    resizeMobileClipboardImage
  )
  if (prepared === image.base64) {
    return image
  }
  const base64 = prepared.replace(DATA_URL_PREFIX_RE, '')
  return { base64, uri: `data:image/png;base64,${base64}` }
}

export function prepareMobileComposerPastedImages(
  images: readonly MobileComposerPastedImage[] | Promise<readonly MobileComposerPastedImage[]>
): Promise<readonly MobileComposerPastedImage[]> {
  return Promise.resolve(images).then((list) => Promise.all(list.map((image) => prepareOne(image))))
}
