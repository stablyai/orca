import * as Clipboard from 'expo-clipboard'
import {
  clipboardReadParamsSchema,
  clipboardWriteParamsSchema,
  type BridgeNativeVerb
} from '../mobile-web-shell/bridge/bridge-native-verbs'

/**
 * The device side of the clipboard verbs, on the shell where `expo-clipboard` exists.
 *
 * Text only, and the wire says so: an image on the pasteboard is `native.media.pick` with
 * `source: 'clipboard'`, which stages it and hands back a handle instead of trying to carry 24 MiB
 * of base64 through an 8 MiB reply.
 *
 * Params are parsed here with the schema for the verb being served, rather than read off the host's
 * parse: the host parses to decide whether to dispatch at all, and this one is the boundary that
 * hands a value to a device API, so it holds a typed value without an assertion.
 */
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
