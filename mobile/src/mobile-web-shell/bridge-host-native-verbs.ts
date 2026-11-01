import type { RpcResponse } from '../transport/types'
import { BridgeNativeVerbRefusedError, readShellRefusalCode } from './bridge-host-errors'
import type { BridgeNativeRefusalCode } from './bridge-host-errors'
import type { BridgeHostDiagnostic } from './bridge-host-contract'
import { mediaPickParamsSchema } from './bridge/bridge-media-verbs'
import {
  BRIDGE_NATIVE_VERB_REFUSAL_CODES,
  BRIDGE_NATIVE_VERBS,
  readBridgeNativeVerbCall,
  type BridgeNativeVerb
} from './bridge/bridge-native-verbs'

export type NativeVerbServerDeps = {
  granted: readonly string[]
  serveVerb: (verb: BridgeNativeVerb, params: unknown) => Promise<unknown>
  onDiagnostic?: (diagnostic: BridgeHostDiagnostic) => void
}

const pickSourceSchema = mediaPickParamsSchema.pick({ source: true }).strip()

// Serve and validate native methods on-device; the desktop client must never see them.
export function createNativeVerbServer(
  deps: NativeVerbServerDeps
): (id: string, method: string, params: unknown) => Promise<RpcResponse> {
  function reportRefusal(
    method: string,
    params: unknown,
    stage: 'pre-dispatch' | 'handler' | 'result',
    reason: BridgeNativeRefusalCode
  ): void {
    if (method !== 'native.media.pick') {
      return
    }
    const read = pickSourceSchema.safeParse(params)
    deps.onDiagnostic?.({
      kind: 'native-media-pick-refused',
      source: read.success ? read.data.source : 'unreported',
      stage,
      reason
    })
  }

  // Handler messages may contain data such as clipboard contents, so retain them only in device logs. Send a recognized code with a fixed message instead.
  async function serve(verb: BridgeNativeVerb, params: unknown): Promise<unknown> {
    try {
      return await deps.serveVerb(verb, params)
    } catch (error) {
      console.warn('[web-shell-bridge] a native verb failed on this device', { verb }, error)
      const reason = readShellRefusalCode(error) ?? 'native_verb_failed'
      reportRefusal(verb, params, 'handler', reason)
      throw new BridgeNativeVerbRefusedError(reason, `${verb} could not be served on this device`)
    }
  }

  return async (id, method, params) => {
    const call = readBridgeNativeVerbCall({ method, granted: deps.granted, params })
    if (!call.ok) {
      reportRefusal(method, params, 'pre-dispatch', BRIDGE_NATIVE_VERB_REFUSAL_CODES[call.refusal])
      throw new BridgeNativeVerbRefusedError(
        BRIDGE_NATIVE_VERB_REFUSAL_CODES[call.refusal],
        call.detail
      )
    }
    const answered = await serve(call.verb, call.params)
    // Validate the result before the page renders it; the verb table is an enforced contract.
    const result = BRIDGE_NATIVE_VERBS[call.verb].result.safeParse(answered)
    if (!result.success) {
      reportRefusal(call.verb, call.params, 'result', 'native_verb_result')
      throw new BridgeNativeVerbRefusedError(
        'native_verb_result',
        `${call.verb} answered a result it does not declare`
      )
    }
    // Use the normal RpcResponse send path to enforce BRIDGE_MAX_REPLY_BYTES without truncation; local replies need no runtime _meta.
    return { id, ok: true, result: result.data }
  }
}
