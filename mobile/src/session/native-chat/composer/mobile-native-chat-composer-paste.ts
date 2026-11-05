import {
  clipboardEventImageFile,
  clipboardEventPromptText,
  type ClipboardEventDataLike
} from '../../../../../src/shared/native-chat/input/native-chat-clipboard-event'
import { isNativeChatLongPaste } from '../../../../../src/shared/native-chat/input/native-chat-long-paste'
import { useClipboardReader, type ClipboardReader } from '../../../platform/clipboard'
import type { PickedMobileImage } from '../../../platform/media-picker-contract'
import { encodeBase64Bytes } from '../../../transport/base64-byte-codec'
import {
  MOBILE_CLIPBOARD_IMAGE_MAX_BASE64_CHARS,
  normalizeMobileClipboardImageBase64,
  prepareMobileClipboardImageBase64
} from '../../mobile-clipboard-image'
import { resizeMobileClipboardImage } from '../../mobile-clipboard-image-resize'

/** Reads the images one paste carried, sized for upload. */
export type MobilePastedImages = () => Promise<readonly PickedMobileImage[]>

type PasteEvent = ClipboardEventDataLike<File> & {
  readonly defaultPrevented: boolean
  preventDefault: () => void
}

async function sizedForUpload(data: string, width: number, height: number): Promise<string> {
  const prepared = await prepareMobileClipboardImageBase64(
    { data, size: { width, height } },
    resizeMobileClipboardImage
  )
  return normalizeMobileClipboardImageBase64(prepared)
}

async function readEventImage(file: Blob): Promise<PickedMobileImage> {
  const base64 = encodeBase64Bytes(new Uint8Array(await file.arrayBuffer()))
  const uri = `data:${file.type};base64,${base64}`
  // Agents read only these formats; anything else (HEIC, TIFF) is re-encoded as PNG.
  const readable = /^image\/(?:png|jpeg|gif|webp)$/.test(file.type)
  if (readable && base64.length <= MOBILE_CLIPBOARD_IMAGE_MAX_BASE64_CHARS) {
    return { base64, uri }
  }
  const image = new Image()
  image.src = uri
  await image.decode()
  const size = { width: image.naturalWidth, height: image.naturalHeight }
  const source = readable ? base64 : (await resizeMobileClipboardImage(base64, size)).data
  return { base64: await sizedForUpload(source, size.width, size.height) }
}

async function readClipboardImage(
  clipboard: Pick<ClipboardReader, 'readImage' | 'contents'>
): Promise<readonly PickedMobileImage[]> {
  if (!(await clipboard.contents()).image) {
    return []
  }
  const image = await clipboard.readImage()
  return image
    ? [{ base64: await sizedForUpload(image.data, image.size.width, image.size.height) }]
    : []
}

/** Text pastes stay native unless long; images attach as chips like Photos picks. A disabled composer leaves pastes to the field. */
export function useMobileNativeChatComposerPaste({
  disabled,
  onPasteImages,
  onAttachPastedText
}: {
  disabled: boolean
  /** Undefined when this chat takes no images. */
  onPasteImages: ((read: MobilePastedImages) => void) | undefined
  /** Undefined when the host keeps no phone files, so a long paste stays prompt text. */
  onAttachPastedText: ((text: string) => void) | undefined
}): (event: PasteEvent) => void {
  const clipboard = useClipboardReader()
  return (event) => {
    if (disabled || event.defaultPrevented) {
      return
    }
    const imageFile = onPasteImages ? clipboardEventImageFile(event) : null
    const text = clipboardEventPromptText(event, imageFile !== null)
    if (text && onAttachPastedText && isNativeChatLongPaste(text)) {
      event.preventDefault()
      onAttachPastedText(text)
    }
    if (!onPasteImages || (text && !imageFile)) {
      return
    }
    if (!text) {
      event.preventDefault()
    }
    // The shell WebView can offer Paste for an image yet leave its bytes out of the event.
    onPasteImages(
      imageFile
        ? async () => [await readEventImage(imageFile)]
        : () => readClipboardImage(clipboard)
    )
  }
}
