import { agentImagePasteWrites } from '../../../src/shared/agent-image-paste'
import {
  buildMobileTerminalImagePastePayload,
  saveMobileClipboardImageAsTempFile
} from './mobile-clipboard-image'
import type { MobileImageSource, PickedMobileImage } from './mobile-image-source-picker'
import { nativeChatTerminalWrite } from './mobile-session-write-operations'
import type { MobileClipboardImageRpcSender } from './mobile-clipboard-image-operations'

export type AttachMobileImageDeps = {
  readonly agent?: string | null
  readonly client: MobileClipboardImageRpcSender
  readonly terminal: string
  readonly deviceToken: string | null
  readonly getConnectionId: () => Promise<string | null>
  // Injected so this module stays free of expo/react-native imports (and unit-testable).
  readonly pickImages: (
    source: MobileImageSource
  ) =>
    | Iterable<PickedMobileImage>
    | AsyncIterable<PickedMobileImage>
    | Promise<Iterable<PickedMobileImage> | AsyncIterable<PickedMobileImage>>
  // Fired once the user has picked images and the host upload is about to
  // start — lets the UI show a sending spinner only for the transfer, not the
  // (potentially long) time the picker is open.
  readonly onUploadStart?: () => void
  readonly beforeTerminalSend?: (terminal: string) => Promise<boolean>
}

// Uploads the picked images to the host and pastes the resulting file paths into the
// active terminal, in pick order — the same bracketed-path payloads desktop image
// paste sends, so TUIs (Claude Code, Codex, etc.) attach each one exactly as a desktop
// paste. Returns false when the user cancelled the picker or the terminal refused a paste.
export async function attachMobileImageToTerminal(
  source: MobileImageSource,
  {
    client,
    agent,
    terminal,
    deviceToken,
    getConnectionId,
    pickImages,
    onUploadStart,
    beforeTerminalSend
  }: AttachMobileImageDeps
): Promise<boolean> {
  const picked = await pickImages(source)
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
        await saveMobileClipboardImageAsTempFile(client, image.base64, { connectionId })
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
  // Why: a generated image path is terminal image injection, so it's always
  // bracketed (matching desktop paste) regardless of terminal mode.
  // The last paste is always separated: attach-then-type is the whole interaction here, so
  // the user's next keystroke would otherwise glue onto the path (`…pngadd`).
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
