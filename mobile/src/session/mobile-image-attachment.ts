import { agentImagePasteWrites } from '../../../src/shared/agent-image-paste'
import {
  buildMobileTerminalImagePastePayload,
  saveMobileClipboardImageAsTempFile
} from './mobile-clipboard-image'
import type { MobileImageSource, PickedMobileImage } from './mobile-image-source-picker'
import { nativeChatTerminalWrite } from './mobile-session-write-operations'
import type { MobileClipboardImageRpcSender } from './mobile-clipboard-image-operations'

type PickedMobileImages =
  | Iterable<PickedMobileImage>
  | AsyncIterable<PickedMobileImage>
  | Promise<Iterable<PickedMobileImage> | AsyncIterable<PickedMobileImage>>

export type AttachMobileImageDeps = {
  readonly agent?: string | null
  readonly client: MobileClipboardImageRpcSender
  readonly terminal: string
  readonly deviceToken: string | null
  readonly getConnectionId: () => Promise<string | null>
  // Injected so this module stays free of expo/react-native imports (and unit-testable).
  // pickImages is the terminal picker. pickImage remains for callers that still attach one image.
  readonly pickImage?: (source: MobileImageSource) => Promise<PickedMobileImage | null>
  readonly pickImages?: (source: MobileImageSource) => PickedMobileImages
  // Start spinner only after selection; the OS picker may remain open a long time.
  readonly onUploadStart?: () => void
  readonly beforeTerminalSend?: (terminal: string) => Promise<boolean>
}

async function selectedImages(
  source: MobileImageSource,
  pickImage: AttachMobileImageDeps['pickImage'],
  pickImages: AttachMobileImageDeps['pickImages']
): Promise<Iterable<PickedMobileImage> | AsyncIterable<PickedMobileImage>> {
  if (pickImages) {
    return await pickImages(source)
  }
  const image = pickImage ? await pickImage(source) : null
  return image ? [image] : []
}

// Uploads the picked images to the host and pastes the resulting file paths into the
// active terminal, in pick order — the same bracketed-path payloads desktop image
// paste sends, so TUIs attach each one exactly as a desktop paste. Returns false
// when the user cancelled the picker or the terminal refused a paste.
export async function attachMobileImageToTerminal(
  source: MobileImageSource,
  {
    client,
    agent,
    terminal,
    deviceToken,
    getConnectionId,
    pickImage,
    pickImages,
    onUploadStart,
    beforeTerminalSend
  }: AttachMobileImageDeps
): Promise<boolean> {
  const picked = await selectedImages(source, pickImage, pickImages)
  const imagePaths: string[] = []
  let uploadFailure: { readonly error: unknown } | null = null
  let connectionId: string | null = null
  try {
    for await (const image of picked) {
      if (imagePaths.length === 0) {
        onUploadStart?.()
        connectionId = await getConnectionId()
      }
      imagePaths.push(
        await saveMobileClipboardImageAsTempFile(client, image.base64, {
          connectionId,
          fileName: image.fileName
        })
      )
    }
  } catch (error) {
    // Why: images uploaded before the failing one are already on the host; pasting them keeps
    // the user's progress, and the failure is still reported once they are in.
    uploadFailure = { error }
  }
  if (imagePaths.length === 0) {
    if (uploadFailure) {
      throw uploadFailure.error
    }
    return false
  }
  if (beforeTerminalSend && !(await beforeTerminalSend(terminal))) {
    return false
  }
  // Always bracket injected image paths atomically. Only the last paste gains a trailing
  // space, so the next keystroke cannot glue onto the filename.
  const writes = agentImagePasteWrites(
    agent,
    imagePaths.map((path) => buildMobileTerminalImagePastePayload(path, agent)),
    true
  )
  for (const text of writes) {
    const response = await nativeChatTerminalWrite.request(client, {
      terminal,
      text,
      enter: false,
      ...(deviceToken ? { client: { id: deviceToken, type: 'mobile' as const } } : {})
    })
    if (nativeChatTerminalWrite.interpret(response) !== true) {
      return false
    }
  }
  if (uploadFailure) {
    throw uploadFailure.error
  }
  return true
}
