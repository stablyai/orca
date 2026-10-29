import { separateImagePasteFromFollowingText } from '../../../src/shared/image-paste-following-text'
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
  readonly pickImage: (source: MobileImageSource) => Promise<PickedMobileImage | null>
  // Start spinner only after selection; the OS picker may remain open a long time.
  readonly onUploadStart?: () => void
  readonly beforeTerminalSend?: (terminal: string) => Promise<boolean>
}

export async function attachMobileImageToTerminal(
  source: MobileImageSource,
  {
    client,
    agent,
    terminal,
    deviceToken,
    getConnectionId,
    pickImage,
    onUploadStart,
    beforeTerminalSend
  }: AttachMobileImageDeps
): Promise<boolean> {
  const picked = await pickImage(source)
  if (!picked) {
    return false
  }
  onUploadStart?.()
  const connectionId = await getConnectionId()
  const imagePath = await saveMobileClipboardImageAsTempFile(client, picked.base64, {
    connectionId,
    fileName: picked.fileName
  })
  // Always bracket injected image paths atomically and append a space so following typing cannot glue onto the filename.
  const payload = separateImagePasteFromFollowingText(
    buildMobileTerminalImagePastePayload(imagePath, agent),
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
