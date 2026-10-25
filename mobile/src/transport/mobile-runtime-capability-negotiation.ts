import {
  MOBILE_RUNTIME_CLIENT_CAPABILITY_UPDATE_METHOD,
  mobileRuntimeClientCapabilityUpdateParams
} from './mobile-runtime-client-capabilities'
import { isRpcDeliveryUnknown } from './rpc-delivery-ambiguity'
import type { RpcResponse } from './types'

type CapabilityRequest = (method: string, params: unknown) => Promise<RpcResponse>

// Only an unsent advisory proves the socket unusable; timeout/drop/refusal mean capabilities unavailable and must still allow connection.
export async function settleMobileRuntimeCapabilities(
  sendRequest: CapabilityRequest
): Promise<void> {
  let response: RpcResponse
  try {
    response = await sendRequest(
      MOBILE_RUNTIME_CLIENT_CAPABILITY_UPDATE_METHOD,
      mobileRuntimeClientCapabilityUpdateParams()
    )
  } catch (error) {
    if (!isRpcDeliveryUnknown(error)) {
      throw error
    }
    console.warn('[net] mobile capability negotiation unanswered — proceeding', error)
    return
  }
  if (!response.ok) {
    console.warn('[net] mobile capability negotiation unavailable', response.error.code)
  }
}

export function negotiateMobileRuntimeCapabilities(args: {
  sendRequest: CapabilityRequest
  current: () => boolean
  onReady: () => void
  onFailure: () => void
}): void {
  void settleMobileRuntimeCapabilities(args.sendRequest)
    .then(() => {
      if (args.current()) {
        args.onReady()
      }
    })
    .catch((error: unknown) => {
      if (!args.current()) {
        return
      }
      // Why: nothing else force-closes a socket that cannot send before `connected` is published.
      console.warn('[net] mobile capability negotiation could not be sent', error)
      args.onFailure()
    })
}
