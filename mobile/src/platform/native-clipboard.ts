import * as Clipboard from 'expo-clipboard'
import {
  clipboardReadParamsSchema,
  clipboardWriteParamsSchema,
  type BridgeNativeVerb,
  type BridgeClipboardMime
} from '../mobile-web-shell/bridge/bridge-native-verbs'

/**
 * The device side of the clipboard verbs, on the shell where `expo-clipboard` exists.
 *
 * Only text is served. `expo-clipboard` implements `getImageAsync` and `setImageAsync`, so the
 * refusal says this build does not serve the verb rather than that the platform cannot: a reason
 * claiming the latter would send whoever adds images looking for a platform gap that is not there.
 */
export class NativeVerbOutOfScopeError extends Error {
  /** Read by the host so this reaches the page as its own reason, without its message. */
  readonly code = 'native_verb_out_of_scope'

  constructor(verb: BridgeNativeVerb, mime: BridgeClipboardMime) {
    super(`${mime} is not served by this build for ${verb}`)
    this.name = 'NativeVerbOutOfScopeError'
  }
}

/**
 * Params are parsed here with the schema for the verb being served, rather than read off the host's
 * parse: the host parses to decide whether to dispatch at all, and this one is the boundary that
 * hands a value to a device API, so it holds a typed value without an assertion.
 */
export async function serveNativeClipboardVerb(
  verb: BridgeNativeVerb,
  params: unknown
): Promise<unknown> {
  if (verb === 'native.clipboard.write') {
    const { mime, value } = clipboardWriteParamsSchema.parse(params)
    refuseNonText(verb, mime)
    return { written: await Clipboard.setStringAsync(value) }
  }
  const { mime } = clipboardReadParamsSchema.parse(params)
  refuseNonText(verb, mime)
  return { value: await Clipboard.getStringAsync() }
}

function refuseNonText(verb: BridgeNativeVerb, mime: BridgeClipboardMime): void {
  if (mime !== 'text') {
    throw new NativeVerbOutOfScopeError(verb, mime)
  }
}
