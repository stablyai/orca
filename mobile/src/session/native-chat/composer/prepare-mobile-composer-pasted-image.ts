import type { MobileComposerPastedImage } from './mobile-native-chat-composer-image-paste'

// Native builds keep the bytes. The page bundle downscales before upload.
export function prepareMobileComposerPastedImages(
  images: readonly MobileComposerPastedImage[] | Promise<readonly MobileComposerPastedImage[]>
): Promise<readonly MobileComposerPastedImage[]> {
  return Promise.resolve(images)
}
