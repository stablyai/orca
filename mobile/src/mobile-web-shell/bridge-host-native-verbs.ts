import type { RpcResponse } from '../transport/types'
import { BridgeNativeVerbRefusedError, readShellRefusalCode } from './bridge-host-errors'
import {
  BRIDGE_NATIVE_VERB_REFUSAL_CODES,
  BRIDGE_NATIVE_VERBS,
  readBridgeNativeVerbCall,
  type BridgeNativeVerb
} from './bridge/bridge-native-verbs'

export type NativeVerbServerDeps = {
  granted: readonly string[]
  serveVerb: (verb: BridgeNativeVerb, params: unknown) => Promise<unknown>
}

// Serve and validate native methods on-device; the desktop client must never see them.
export function createNativeVerbServer(
  deps: NativeVerbServerDeps
): (id: string, method: string, params: unknown) => Promise<RpcResponse> {
  // Handler messages may contain data such as clipboard contents, so retain them only in device logs. Send a recognized code with a fixed message instead.
  async function serve(verb: BridgeNativeVerb, params: unknown): Promise<unknown> {
    try {
      return await deps.serveVerb(verb, params)
    } catch (error) {
      console.warn('[web-shell-bridge] a native verb failed on this device', { verb }, error)
      throw new BridgeNativeVerbRefusedError(
        readShellRefusalCode(error) ?? 'native_verb_failed',
        `${verb} could not be served on this device`
      )
    }
  }

  return async (id, method, params) => {
    const call = readBridgeNativeVerbCall({ method, granted: deps.granted, params })
    if (!call.ok) {
      throw new BridgeNativeVerbRefusedError(
        BRIDGE_NATIVE_VERB_REFUSAL_CODES[call.refusal],
        call.detail
      )
    }
    const answered = await serve(call.verb, call.params)
    // Validate the result before the page renders it; the verb table is an enforced contract.
    const result = BRIDGE_NATIVE_VERBS[call.verb].result.safeParse(answered)
    if (!result.success) {
      throw new BridgeNativeVerbRefusedError(
        'native_verb_result',
        `${call.verb} answered a result it does not declare`
      )
    }
    // Use the normal RpcResponse send path to enforce BRIDGE_MAX_REPLY_BYTES without truncation; local replies need no runtime _meta.
    return { id, ok: true, result: result.data }
  }
}
