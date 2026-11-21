import { separateImagePasteFromFollowingText } from '../../../../src/shared/terminal/input/image-paste-following-text'
import {
  buildMobileTerminalImagePastePayload,
  saveMobileClipboardImageAsTempFile
} from './mobile-clipboard-image'
import {
  MobileUploadCancelledError,
  type MobileGalleryPick,
  MobileImageSource,
  PickedMobileFile,
  PickedMobileImage
} from '../../platform/media-picking/media-picker-contract'
import { uploadMobileTerminalFile } from './mobile-terminal-file-upload'
import { nativeChatTerminalWrite } from '../../terminal/session/mobile-session-terminal-operations'
import type { MobileClipboardImageRpcSender } from './mobile-clipboard-image-operations'

export type AttachMobileImageDeps = {
  readonly agent?: string | null
  readonly client: MobileClipboardImageRpcSender
  readonly terminal: string
  readonly deviceToken: string | null
  readonly getConnectionId: () => Promise<string | null>
  // Injected so this module stays free of expo/react-native imports (and unit-testable).
  readonly pickImage: (source: MobileImageSource) => Promise<PickedMobileImage | null>
  // Start spinner only after selection; the OS picker may remain open a long time.
  readonly onUploadStart?: () => void
  readonly fitImage?: (image: PickedMobileImage) => Promise<PickedMobileImage>
  readonly beforeTerminalSend?: (terminal: string) => Promise<boolean>
  // True once the user stops the transfer; checked between chunks and before each paste.
  readonly shouldCancel?: () => boolean
}

export async function attachMobileImageToTerminal(
  source: MobileImageSource,
  deps: AttachMobileImageDeps
): Promise<boolean> {
  const pickedImage = await deps.pickImage(source)
  if (!pickedImage) {
    return false
  }
  return pasteMobileImageIntoTerminal(pickedImage, deps)
}

type TerminalPasteDeps = Omit<AttachMobileImageDeps, 'pickImage'>

// Picks may hold many files; each is uploaded and pasted in order, stopping at the first failure.
export async function attachMobileFilesToTerminal(
  deps: TerminalPasteDeps & {
    readonly pickFiles: () => AsyncIterable<PickedMobileFile>
  }
): Promise<boolean> {
  let sentAny = false
  for await (const file of deps.pickFiles()) {
    if (!(await pasteMobileFileIntoTerminal(file, deps))) {
      return sentAny
    }
    sentAny = true
  }
  return sentAny
}

// One gallery pick: photos paste as images, videos as streamed files; cache copies of unsent videos go when it ends.
export async function attachMobileGalleryToTerminal(
  deps: TerminalPasteDeps & { readonly pickGallery: () => Promise<MobileGalleryPick> }
): Promise<boolean> {
  const { images, videos } = await deps.pickGallery()
  let sentAny = false
  try {
    for (const image of images) {
      if (!(await pasteMobileImageIntoTerminal(image, deps))) {
        return sentAny
      }
      sentAny = true
    }
    for (const video of videos) {
      if (!(await pasteMobileFileIntoTerminal(video, deps))) {
        return sentAny
      }
      sentAny = true
    }
    return sentAny
  } finally {
    videos.forEach((video) => video.dispose?.())
  }
}

async function pasteMobileFileIntoTerminal(
  file: PickedMobileFile,
  deps: TerminalPasteDeps
): Promise<boolean> {
  deps.onUploadStart?.()
  const connectionId = await deps.getConnectionId()
  const path = await uploadMobileTerminalFile(deps.client, file, {
    connectionId,
    shouldCancel: deps.shouldCancel
  }).finally(() => file.dispose?.())
  return pastePathIntoTerminal(path, deps)
}

async function pasteMobileImageIntoTerminal(
  pickedImage: PickedMobileImage,
  deps: TerminalPasteDeps
): Promise<boolean> {
  deps.onUploadStart?.()
  const picked = deps.fitImage ? await deps.fitImage(pickedImage) : pickedImage
  if (deps.shouldCancel?.()) {
    throw new MobileUploadCancelledError()
  }
  const connectionId = await deps.getConnectionId()
  const imagePath = await saveMobileClipboardImageAsTempFile(deps.client, picked.base64, {
    connectionId,
    fileName: picked.fileName
  })
  return pastePathIntoTerminal(imagePath, deps)
}

async function pastePathIntoTerminal(
  path: string,
  { client, agent, terminal, deviceToken, beforeTerminalSend, shouldCancel }: TerminalPasteDeps
): Promise<boolean> {
  if (shouldCancel?.()) {
    throw new MobileUploadCancelledError()
  }
  // Always bracket injected paths atomically and append a space so following typing cannot glue onto the filename.
  const payload = separateImagePasteFromFollowingText(
    buildMobileTerminalImagePastePayload(path, agent),
    true
  )
  if (beforeTerminalSend && !(await beforeTerminalSend(terminal))) {
    return false
  }
  const response = await nativeChatTerminalWrite.request(client, {
    terminal,
    text: payload,
    enter: false,
    ...(deviceToken ? { client: { id: deviceToken, type: 'mobile' as const } } : {})
  })
  return nativeChatTerminalWrite.interpret(response) === true
}
