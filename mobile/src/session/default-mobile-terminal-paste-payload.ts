import * as Clipboard from 'expo-clipboard'
import type { TerminalModes } from '../terminal/terminal-webview-contract'
import type { RpcClient } from '../transport/rpc-client'
import {
  buildMobileImagePastePayload,
  prepareMobileClipboardImageBase64,
  saveMobileClipboardImageAsTempFile
} from './mobile-clipboard-image'
import { resizeMobileClipboardImage } from './mobile-clipboard-image-resizer'
import { buildMobileTerminalClipboardTextPayload } from './mobile-terminal-clipboard-text'

export async function defaultMobileTerminalPastePayload(args: {
  client: RpcClient
  connectionId: () => Promise<string | null>
  modes: TerminalModes | undefined
}): Promise<string | null> {
  const text = await Clipboard.getStringAsync()
  if (text.length > 0) {
    return buildMobileTerminalClipboardTextPayload(text, args.modes)
  }
  const image = await Clipboard.getImageAsync({ format: 'png' })
  if (!image) {
    return null
  }
  const connectionId = await args.connectionId()
  const base64 = await prepareMobileClipboardImageBase64(image, resizeMobileClipboardImage)
  const imagePath = await saveMobileClipboardImageAsTempFile(args.client, base64, {
    connectionId
  })
  return buildMobileImagePastePayload(imagePath)
}
