import { uploadMobileTerminalFile } from '../../../../files/attachments/mobile-terminal-file-upload'
import { inMemoryBase64Chunks } from '../../../../platform/media-picking/picked-file-base64-chunks'
import { base64DecodedByteLength } from '../../../../../../src/shared/agent-session/agent-session-attachments'
import type { MobileClipboardImageRpcSender } from '../../../../files/attachments/mobile-clipboard-image-operations'
// Keep picker dependencies type-only so this upload module stays free of Expo/React Native at runtime.
import type {
  MobileImageSource,
  PickedMobileFile,
  PickedMobileImage
} from '../../../../platform/media-picking/media-picker-contract'

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/svg+xml': 'svg'
}

// Stored under a real name and extension so the host and the chat can tell what the file is.
function pickedImageFile(image: PickedMobileImage): PickedMobileFile {
  const mime = image.mime ?? 'image/png'
  return {
    name: image.fileName ?? `image.${IMAGE_EXTENSIONS[mime] ?? 'png'}`,
    mime,
    byteLength: base64DecodedByteLength(image.base64),
    chunks: () => inMemoryBase64Chunks(image.base64),
    ...(image.fileName ? {} : { generatedName: true })
  }
}

// path belongs to the host for sending; previewUri belongs to the phone for display.
export type PendingNativeChatImage = {
  readonly id: string
  readonly path: string
  readonly previewUri: string
  /** Set only while the file is still uploading; such a chip is never sent or saved. */
  readonly upload?: NativeChatImageUpload
}

export type NativeChatImageUpload = {
  readonly name: string
  readonly mime: string
  readonly byteLength: number
  readonly sentBytes: number
}

export function appendPendingNativeChatImages(
  current: readonly PendingNativeChatImage[],
  uploaded: readonly Omit<PendingNativeChatImage, 'id'>[],
  idCounter: { current: number }
): PendingNativeChatImage[] {
  return [
    ...current,
    ...uploaded.map((image) => {
      idCounter.current += 1
      return { id: `img-${idCounter.current}`, ...image }
    })
  ]
}

export type UploadNativeChatImagesDeps<S = MobileImageSource> = {
  readonly canContinue?: () => boolean
  readonly client: MobileClipboardImageRpcSender
  readonly getConnectionId: () => Promise<string | null>
  readonly pickImages: (
    source: S
  ) =>
    | Iterable<PickedMobileImage>
    | AsyncIterable<PickedMobileImage>
    | Promise<Iterable<PickedMobileImage> | AsyncIterable<PickedMobileImage>>
  readonly onUploadStart?: () => void
  // Injected so this module stays free of the page's canvas.
  readonly fitImage?: (image: PickedMobileImage) => Promise<PickedMobileImage>
  /** Retains each completed upload if a later image in the same selection fails. */
  readonly onImageUploaded?: (image: Omit<PendingNativeChatImage, 'id'>) => void
}

// Upload without pasting: chat holds composer chips until submit so visible attachments cannot diverge from agent input.
export async function uploadMobileNativeChatImages<S>(
  source: S,
  {
    client,
    canContinue,
    getConnectionId,
    pickImages,
    onUploadStart,
    fitImage,
    onImageUploaded
  }: UploadNativeChatImagesDeps<S>
): Promise<Omit<PendingNativeChatImage, 'id'>[]> {
  const picked = await pickImages(source)
  const uploaded: Omit<PendingNativeChatImage, 'id'>[] = []
  let connectionId: string | null = null
  if (canContinue?.() === false) {
    return uploaded
  }
  for await (const pickedImage of picked) {
    if (canContinue?.() === false) {
      break
    }
    if (uploaded.length === 0) {
      onUploadStart?.()
      connectionId = await getConnectionId()
    }
    if (canContinue?.() === false) {
      break
    }
    const image = fitImage ? await fitImage(pickedImage) : pickedImage
    const path = await uploadMobileTerminalFile(client, pickedImageFile(image), { connectionId })
    const previewUri = image.uri ?? `data:image/png;base64,${image.base64}`
    const result = {
      path,
      previewUri
    }
    uploaded.push(result)
    onImageUploaded?.(result)
    if (canContinue?.() === false) {
      break
    }
  }
  return uploaded
}
