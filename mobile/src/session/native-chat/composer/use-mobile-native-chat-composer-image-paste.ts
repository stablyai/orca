import { useContext } from 'react'
import {
  mobileComposerImagePasteTarget,
  type MobileComposerImagePasteHandler
} from './mobile-native-chat-composer-image-paste'
import { MobileNativeChatImagePasteContext } from './mobile-native-chat-image-paste-context'
import { useMobileComposerClipboardImageReader } from './use-mobile-composer-clipboard-image'

export function useMobileNativeChatComposerImagePaste(
  onPasteImages: MobileComposerImagePasteHandler | undefined,
  editSession: { locked?: boolean } | undefined
) {
  const clipboardImage = useMobileComposerClipboardImageReader()
  const imagePasteFromRoute = useContext(MobileNativeChatImagePasteContext)
  const target = mobileComposerImagePasteTarget(
    onPasteImages,
    imagePasteFromRoute,
    editSession !== undefined
  )
  const locked = editSession?.locked
  return {
    host: target && !locked ? clipboardImage.host : null,
    onPasteImages: locked ? undefined : target,
    readClipboardImage: clipboardImage.read
  }
}
