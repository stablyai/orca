import type { RpcResponse } from '../transport/types'
import { BridgeNativeVerbRefusedError, readShellRefusalCode } from './bridge-host-errors'
import {
  BRIDGE_NATIVE_VERB_REFUSAL_CODES,
  BRIDGE_NATIVE_VERBS,
  readBridgeNativeVerbCall,
  type BridgeNativeVerb
} from './bridge/bridge-native-verbs'

export type NativeVerbServerDeps = {
  /** What `init` advertised, which is what a page may call. */
  granted: readonly string[]
  /** Serves one verb on this device. Rejecting is how it refuses. */
  serveVerb: (verb: BridgeNativeVerb, params: unknown) => Promise<unknown>
}

/**
 * The shell-answered half of the request port: a `native.` method decided, served and shaped into
 * a reply, without the desktop client being involved at any point.
 *
 * Split from the host because it is a whole decision of its own — read the call, serve it, hold the
 * answer to what the verb declares — and the host's job is the frames around it.
 */
export function createNativeVerbServer(
  deps: NativeVerbServerDeps
): (id: string, method: string, params: unknown) => Promise<RpcResponse> {
  /**
   * A handler's own failure, re-raised under this seam's vocabulary with a message of our making.
   *
   * The handler's words do not cross. It is the one thing here holding data the page asked for and
   * may not have — a clipboard read that failed after reading is free to put what it read in its
   * message — and an error frame is the only path out of this seam that is not a declared result.
   * Its code does cross, because an out-of-scope mime and a device that failed are different
   * things to act on. The shell keeps the real message, where a device log can show it.
   */
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
    // The table declares what a verb answers, and without this that claim was decoration: a
    // handler could hand the page any shape and the page's own parse would be the first to notice,
    // halfway through a screen.
    const result = BRIDGE_NATIVE_VERBS[call.verb].result.safeParse(answered)
    if (!result.success) {
      throw new BridgeNativeVerbRefusedError(
        'native_verb_result',
        `${call.verb} answered a result it does not declare`
      )
    }
    // Built as an `RpcResponse` so it rides `sendReply` like any other reply: that is what applies
    // `BRIDGE_MAX_REPLY_BYTES`, so a clipboard too large for the page is refused rather than
    // truncated. No `_meta` — no runtime produced this, and `isRpcResponse` does not require one.
    return { id, ok: true, result: result.data }
  }
}
