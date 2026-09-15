import type { RpcClient } from '../transport/rpc-client'
import { separateImagePasteFromFollowingText } from '../../../src/shared/image-paste-following-text'
import {
  buildMobileImagePastePayload,
  saveMobileClipboardImageAsTempFile
} from './mobile-clipboard-image'
import type { MobileImageSource, PickedMobileImage } from './mobile-image-source-picker'
import { isTerminalSendRpcAccepted } from '../terminal/terminal-send-rpc-response'

export type AttachMobileImageDeps = {
  readonly agent?: string | null
  readonly client: Pick<RpcClient, 'sendRequest'>
  readonly terminal: string
  readonly deviceToken: string | null
  readonly getConnectionId: () => Promise<string | null>
  // Injected so this module stays free of expo/react-native imports (and unit-testable).
  readonly pickImage: (source: MobileImageSource) => Promise<PickedMobileImage | null>
  // Fired once the user has picked an image and the host upload is about to
  // start — lets the UI show a sending spinner only for the transfer, not the
  // (potentially long) time the picker is open.
  readonly onUploadStart?: () => void
  readonly beforeTerminalSend?: (terminal: string) => Promise<boolean>
}

// Capture the terminal and agent before opening the picker.
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
    connectionId
  })
  // Always separated: attach-then-type is the whole interaction here, so the user's
  // next keystroke would otherwise glue onto the path (`…pngadd`). Unlike native
  // chat there is no batch to look ahead in, and a trailing space is inert.
  const payload = separateImagePasteFromFollowingText(
    buildMobileImagePastePayload(imagePath, agent),
    true
  )
  if (beforeTerminalSend && !(await beforeTerminalSend(terminal))) {
    return false
  }
  const response = await client.sendRequest('terminal.send', {
    terminal,
    text: payload,
    enter: false,
    ...(deviceToken ? { client: { id: deviceToken, type: 'mobile' as const } } : {})
  })
  return isTerminalSendRpcAccepted(response)
}
