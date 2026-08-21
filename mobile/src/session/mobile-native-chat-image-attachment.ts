import type { RpcClient } from '../transport/rpc-client'
import { saveMobileClipboardImageAsTempFile } from './mobile-clipboard-image'
// Type-only import so this module (and its unit test) stays free of the expo/
// react-native picker chain; the concrete `pickImage` is injected by the hook.
import type { MobileImageSource, PickedMobileImage } from './mobile-image-source-picker'

/** A picked-and-uploaded image held in the native-chat composer until submit.
 *  `path` is the host temp file pasted into the agent on send; `previewUri` is a
 *  local URI used only to render the composer thumbnail. */
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
  readonly client: Pick<RpcClient, 'sendRequest'>
  readonly getConnectionId: () => Promise<string | null>
  // Injected so this module stays free of expo/react-native imports (unit-testable).
  readonly pickImages: (
    source: MobileImageSource
  ) =>
    | Iterable<PickedMobileImage>
    | AsyncIterable<PickedMobileImage>
    | Promise<Iterable<PickedMobileImage> | AsyncIterable<PickedMobileImage>>
  // Fired once the user has picked an image and the host upload is about to start —
  // lets the UI show the attach spinner only for the transfer, not the picker.
  readonly onUploadStart?: () => void
  /** Retains each completed upload if a later image in the same selection fails. */
  readonly onImageUploaded?: (image: Omit<PendingNativeChatImage, 'id'>) => void
}

/** Picks an image and uploads it to the host, returning the host path + a local
 *  preview URI — but does NOT paste it into the terminal. Unlike the terminal
 *  attach flow, native chat holds the image as a composer chip and rides it along
 *  on submit (desktop parity), so the chip and the agent input never diverge.
 *  Returns an empty array when the user cancels the picker. */
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
    // Prefer the picker's local URI for the thumbnail; fall back to an inline data
    // URI when the source omitted one (RN <Image> renders both).
    const previewUri = image.uri ?? `data:image/png;base64,${image.base64}`
    const result = { path, previewUri }
    uploaded.push(result)
    onImageUploaded?.(result)
  }
  return uploaded
}
