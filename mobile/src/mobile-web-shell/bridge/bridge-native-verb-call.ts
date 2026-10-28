import type { RpcResponse, RpcSuccess } from '../../transport/types'
import { BridgeClientNotNativeVerbError } from './bridge-client-errors'
import { isBridgeNativeMethod, type BridgeNativeVerb } from './bridge-native-verbs'

export function callBridgeNativeVerb(
  sendRequest: (method: string, params: unknown) => Promise<RpcResponse>,
  verb: BridgeNativeVerb,
  params: unknown
): Promise<RpcSuccess> {
  // Validate the typed verb at runtime too; widened callers must not turn this into an untracked raw desktop RPC port.
  if (!isBridgeNativeMethod(verb)) {
    return Promise.reject(new BridgeClientNotNativeVerbError(verb))
  }
  return sendRequest(verb, params).then((reply) => {
    // Native refusals reject as error frames and never forward to desktop, so the return has no RpcFailure arm.
    if (!reply.ok) {
      throw new Error(reply.error.message)
    }
    return reply
  })
}
