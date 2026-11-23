import {
  MOBILE_RUNTIME_CLIENT_CAPABILITY_UPDATE_METHOD,
  mobileRuntimeClientCapabilityUpdateParams
} from './mobile-runtime-client-capabilities'
import { isRpcDeliveryUnknown } from '../rpc/rpc-delivery-ambiguity'
import {
  pageClientCapabilities,
  watchPageClientCapabilities
} from './mobile-page-client-capabilities'
import { defineRpcOperation, runRpcOperation } from '../rpc/rpc-operation'
import type { RpcClient } from '../rpc/rpc-client-contract'
import type { RpcResponse } from '../rpc/rpc-wire-types'

type CapabilityRequest = (method: string, params: unknown) => Promise<RpcResponse>

// Only an unsent advisory proves the socket unusable; timeout/drop/refusal mean capabilities unavailable and must still allow connection.
export async function settleMobileRuntimeCapabilities(
  sendRequest: CapabilityRequest,
  hostId?: string
): Promise<void> {
  let response: RpcResponse
  try {
    response = await sendRequest(
      MOBILE_RUNTIME_CLIENT_CAPABILITY_UPDATE_METHOD,
      mobileRuntimeClientCapabilityUpdateParams(pageClientCapabilities(hostId))
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
  hostId?: string
  current: () => boolean
  onReady: () => void
  onFailure: () => void
}): void {
  void settleMobileRuntimeCapabilities(args.sendRequest, args.hostId)
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

// An advisory: the host keeps the list, and its reply carries nothing the phone reads.
const clientCapabilitiesUpdate = defineRpcOperation({
  name: 'runtime.client-capabilities.update',
  method: MOBILE_RUNTIME_CLIENT_CAPABILITY_UPDATE_METHOD,
  acceptance: 'method-not-found-refusal',
  barrier: 'on-settle'
})

/** A connected host hears at once when the page loaded for it changes what it can draw; a change while
 *  the socket is still coming up is sent once it connects, since authentication may have read the old list. */
export function readvertiseOnPageChange(hostId: string, client: RpcClient): () => void {
  let unsent = false
  const advertise = (): void => {
    unsent = false
    void runRpcOperation(
      client,
      clientCapabilitiesUpdate,
      mobileRuntimeClientCapabilityUpdateParams(pageClientCapabilities(hostId)),
      { failWhenDisconnected: true }
    ).catch((error: unknown) => {
      console.warn('[net] page capability update unsent', error)
    })
  }
  const stopPage = watchPageClientCapabilities(hostId, () => {
    if (client.getState() === 'connected') {
      advertise()
    } else {
      unsent = true
    }
  })
  const stopState = client.onStateChange((state) => {
    if (state === 'connected' && unsent) {
      advertise()
    }
  })
  return () => {
    stopPage()
    stopState()
  }
}
