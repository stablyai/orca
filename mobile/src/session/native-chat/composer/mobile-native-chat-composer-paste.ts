import {
  clipboardEventImageFile,
  clipboardEventPromptText,
  type ClipboardEventDataLike
} from '../../../../../src/shared/native-chat/input/native-chat-clipboard-event'
import { isNativeChatLongPaste } from '../../../../../src/shared/native-chat/input/native-chat-long-paste'
import { useClipboardReader, type ClipboardReader } from '../../../platform/clipboard'
import type { PickedMobileImage } from '../../../platform/media-picker-contract'
import { encodeBase64Bytes } from '../../../transport/base64-byte-codec'
import { prepareMobileClipboardImageBase64 } from '../../mobile-clipboard-image'
import { resizeMobileClipboardImage } from '../../mobile-clipboard-image-resize'

/** Reads the images one paste carried, sized for upload. */
export type MobilePastedImages = () => Promise<readonly PickedMobileImage[]>

export type MobileNativeChatComposerPasteTargets = {
  /** Null when this chat takes no images. */
  readonly attachImages: ((read: MobilePastedImages) => void) | null
  /** Null when the host keeps no phone files, so a long paste stays prompt text. */
  readonly attachPastedText: ((text: string) => void) | null
  readonly clipboard: Pick<ClipboardReader, 'readImage' | 'contents'>
}

type PasteEvent = ClipboardEventDataLike<File> & {
  readonly defaultPrevented: boolean
  preventDefault: () => void
}

const DATA_URL_PREFIX_RE = /^data:image\/[a-z0-9.+-]+;base64,/i

async function sizedForUpload(data: string, width: number, height: number): Promise<string> {
  const prepared = await prepareMobileClipboardImageBase64(
    { data, size: { width, height } },
    resizeMobileClipboardImage
  )
  return prepared.replace(DATA_URL_PREFIX_RE, '')
}

async function readEventImage(file: Blob): Promise<PickedMobileImage> {
  const base64 = encodeBase64Bytes(new Uint8Array(await file.arrayBuffer()))
  const uri = `data:${file.type};base64,${base64}`
  const image = new Image()
  image.src = uri
  await image.decode()
  const sized = await sizedForUpload(base64, image.naturalWidth, image.naturalHeight)
  return sized === base64 ? { base64, uri } : { base64: sized }
}

async function readClipboardImage(
  clipboard: MobileNativeChatComposerPasteTargets['clipboard']
): Promise<readonly PickedMobileImage[]> {
  if (!(await clipboard.contents()).image) {
    return []
  }
  const image = await clipboard.readImage()
  return image
    ? [{ base64: await sizedForUpload(image.data, image.size.width, image.size.height) }]
    : []
}

/** Text pastes stay native unless long; images attach as chips like Photos picks. */
export function handleMobileNativeChatComposerPaste(
  event: PasteEvent,
  { attachImages, attachPastedText, clipboard }: MobileNativeChatComposerPasteTargets
): void {
  if (event.defaultPrevented) {
    return
  }
  const imageFile = attachImages ? clipboardEventImageFile(event) : null
  const text = clipboardEventPromptText(event, imageFile !== null)
  if (text && attachPastedText && isNativeChatLongPaste(text)) {
    event.preventDefault()
    attachPastedText(text)
  }
  if (!attachImages || (text && !imageFile)) {
    return
  }
  if (!text) {
    event.preventDefault()
  }
  // The shell WebView can offer Paste for an image yet leave its bytes out of the event.
  attachImages(
    imageFile ? async () => [await readEventImage(imageFile)] : () => readClipboardImage(clipboard)
  )
}

/** The composer field's paste handler; a disabled composer leaves pastes to the field. */
export function useMobileNativeChatComposerPaste({
  disabled,
  onPasteImages,
  onAttachPastedText
}: {
  disabled: boolean
  onPasteImages: ((read: MobilePastedImages) => void) | undefined
  onAttachPastedText: ((text: string) => void) | undefined
}): (event: ClipboardEvent) => void {
  const clipboard = useClipboardReader()
  return (event) =>
    handleMobileNativeChatComposerPaste(event, {
      attachImages: disabled ? null : (onPasteImages ?? null),
      attachPastedText: disabled ? null : (onAttachPastedText ?? null),
      clipboard
    })
}
