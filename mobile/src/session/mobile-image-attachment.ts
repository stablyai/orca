import type { RpcClient } from '../transport/rpc-client'
import {
  buildMobileImagePastePayload,
  saveMobileClipboardImageAsTempFile
} from './mobile-clipboard-image'
import type { MobileImageSource, PickedMobileImage } from './mobile-image-source-picker'

export type AttachMobileImageDeps = {
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
}

// Uploads a picked image to the host and pastes the resulting file path into the
// active terminal — the same bracketed-path payload desktop image paste sends, so
// TUIs (Claude Code, etc.) attach it exactly as a desktop paste. Returns false
// when the user cancelled the picker.
export async function attachMobileImageToTerminal(
  source: MobileImageSource,
  {
    client,
    terminal,
    deviceToken,
    getConnectionId,
    pickImage,
    onUploadStart
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
  // Why: a generated image path is terminal image injection, so it's always
  // bracketed (matching desktop paste) regardless of terminal mode.
  const payload = buildMobileImagePastePayload(imagePath)
  await client.sendRequest('terminal.send', {
    terminal,
    text: payload,
    enter: false,
    ...(deviceToken ? { client: { id: deviceToken, type: 'mobile' as const } } : {})
  })
  return true
}
