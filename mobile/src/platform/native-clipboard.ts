import * as Clipboard from 'expo-clipboard'
import {
  clipboardReadParamsSchema,
  clipboardWriteParamsSchema,
  type BridgeNativeVerb
} from '../mobile-web-shell/bridge/bridge-native-verbs'

// Text-only: images use staged media handles to stay below reply caps. Parse again at the device boundary for checked types without assertions.
export async function serveNativeClipboardVerb(
  verb: BridgeNativeVerb,
  params: unknown
): Promise<unknown> {
  if (verb === 'native.clipboard.write') {
    const { value } = clipboardWriteParamsSchema.parse(params)
    return { written: await Clipboard.setStringAsync(value) }
  }
  clipboardReadParamsSchema.parse(params)
  return { value: await Clipboard.getStringAsync() }
}
