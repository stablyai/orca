import {
  clipboardEventImageFile,
  clipboardEventNonImageFiles,
  clipboardEventPromptText,
  type ClipboardEventDataLike
} from '../../../../../../src/shared/native-chat/input/composer/native-chat-clipboard-event'
import { isNativeChatLongPaste } from '../../../../../../src/shared/native-chat/input/composer/native-chat-long-paste'
import type { ClipboardReader } from '../../../../platform/clipboard/clipboard'
import type {
  MobileImageSource,
  PickedMobileImage
} from '../../../../platform/media-picking/media-picker-contract'
import { encodeBase64Bytes } from '../../../../transport/encryption/base64-byte-codec'

/** One paste's image: the event's file, or null when WebKit left the bytes out and the shell clipboard holds them. */
export type MobilePastedImages = { readonly file: File | null }

/** Images a gallery selection already read; they join the same upload as a library pick. */
export type MobilePreparedImages = { readonly prepared: readonly PickedMobileImage[] }

export type MobileNativeChatImageSource =
  | MobileImageSource
  | MobilePastedImages
  | MobilePreparedImages

type PasteEvent = ClipboardEventDataLike<File> & {
  readonly defaultPrevented: boolean
  preventDefault: () => void
}

/** Raw bytes; the uploader fits them for agents. The clipboard reader is the uploader's, so the composer needs no shell bridge. */
export async function readMobilePastedImages(
  { file }: MobilePastedImages,
  clipboard: Pick<ClipboardReader, 'readImage' | 'contents'>
): Promise<readonly PickedMobileImage[]> {
  if (file) {
    return [
      { base64: encodeBase64Bytes(new Uint8Array(await file.arrayBuffer())), mime: file.type }
    ]
  }
  if (!(await clipboard.contents()).image) {
    return []
  }
  const image = await clipboard.readImage()
  return image ? [{ base64: image.data }] : []
}

/** Text pastes stay native unless long; images and other files attach as chips like picks. A disabled composer leaves pastes to the field. */
export function mobileNativeChatComposerPasteHandler({
  disabled,
  onPasteImages,
  onAttachPastedText,
  onPasteFiles
}: {
  disabled: boolean
  /** Undefined when this chat takes no images. */
  onPasteImages: ((paste: MobilePastedImages) => void) | undefined
  /** Undefined when the host keeps no phone files, so a long paste stays prompt text. */
  onAttachPastedText: ((text: string) => void) | undefined
  /** Undefined when the host keeps no phone files, so a pasted file stays with the field. */
  onPasteFiles: ((files: readonly File[]) => void) | undefined
}): (event: PasteEvent) => void {
  return (event) => {
    if (disabled || event.defaultPrevented) {
      return
    }
    const imageFile = onPasteImages ? clipboardEventImageFile(event) : null
    // A link copied without plain text (iOS share sheet) is still text; an image's source URL is not.
    const listsImage = Array.from(event.clipboardData?.items ?? []).some((item) =>
      item.type.startsWith('image/')
    )
    const files = onPasteFiles ? clipboardEventNonImageFiles(event) : []
    const text =
      clipboardEventPromptText(event, imageFile !== null || files.length > 0) ||
      (listsImage ? '' : (event.clipboardData?.getData('text/uri-list') ?? ''))
    if (text && onAttachPastedText && isNativeChatLongPaste(text)) {
      event.preventDefault()
      onAttachPastedText(text)
    }
    if (files.length > 0 && onPasteFiles) {
      if (!text) {
        event.preventDefault()
      }
      onPasteFiles(files)
      if (!imageFile) {
        return
      }
    }
    if (!onPasteImages || (text && !imageFile)) {
      return
    }
    if (!text) {
      event.preventDefault()
    }
    // The shell WebView can offer Paste for an image yet leave its bytes out of the event.
    onPasteImages({ file: imageFile })
  }
}
