import { saveMobileClipboardImageAsTempFile } from '../../mobile-clipboard-image'
import type { MobileClipboardImageRpcSender } from '../../mobile-clipboard-image-operations'
// Keep picker dependencies type-only so this upload module stays free of Expo/React Native at runtime.
import type { MobileImageSource, PickedMobileImage } from '../../../platform/media-picker-contract'

// path belongs to the host for sending; previewUri belongs to the phone for display.
export type PendingNativeChatImage = {
  readonly id: string
  readonly path: string
  readonly previewUri: string
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

export type UploadNativeChatImagesDeps = {
  readonly client: MobileClipboardImageRpcSender
  readonly getConnectionId: () => Promise<string | null>
  readonly pickImages: (
    source: MobileImageSource
  ) =>
    | Iterable<PickedMobileImage>
    | AsyncIterable<PickedMobileImage>
    | Promise<Iterable<PickedMobileImage> | AsyncIterable<PickedMobileImage>>
  readonly onUploadStart?: () => void
  /** Retains each completed upload if a later image in the same selection fails. */
  readonly onImageUploaded?: (image: Omit<PendingNativeChatImage, 'id'>) => void
}

// Upload without pasting: chat holds composer chips until submit so visible attachments cannot diverge from agent input.
export async function uploadMobileNativeChatImages(
  source: MobileImageSource,
  {
    client,
    getConnectionId,
    pickImages,
    onUploadStart,
    onImageUploaded
  }: UploadNativeChatImagesDeps
): Promise<Omit<PendingNativeChatImage, 'id'>[]> {
  const picked = await pickImages(source)
  const uploaded: Omit<PendingNativeChatImage, 'id'>[] = []
  let connectionId: string | null = null
  for await (const image of picked) {
    if (uploaded.length === 0) {
      onUploadStart?.()
      connectionId = await getConnectionId()
    }
    const path = await saveMobileClipboardImageAsTempFile(client, image.base64, { connectionId })
    const previewUri = image.uri ?? `data:image/png;base64,${image.base64}`
    const result = {
      path,
      previewUri
    }
    uploaded.push(result)
    onImageUploaded?.(result)
  }
  return uploaded
}
