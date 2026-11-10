import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { createSessionTabsTabDeltaDecoder } from '../../../shared/session-tabs-tab-delta'

type SubscriptionEvent =
  | { type: 'response'; response: RuntimeRpcResponse<unknown> }
  | { type: 'binary'; bytes: Uint8Array<ArrayBufferLike> }
  | { type: 'error'; code: string; message: string }
  | { type: 'close' }

export const SESSION_TABS_DELTA_OUT_OF_SYNC_ERROR = 'session_tabs_delta_out_of_sync'

/** Decode deltas before consumers so windows and layout recording see legacy-compatible full frames. */
export function decodeSessionTabsDeltaEvents(
  method: string,
  onEvent: (payload: SubscriptionEvent) => void
): (payload: SubscriptionEvent) => void {
  if (method !== 'session.tabs.subscribe' && method !== 'session.tabs.subscribeAll') {
    return onEvent
  }
  const decoder = createSessionTabsTabDeltaDecoder()
  return (payload) => {
    if (payload.type !== 'response' || payload.response.ok !== true) {
      onEvent(payload)
      return
    }
    const response = payload.response
    const decoded = decoder.decode(response.result)
    if (decoded.ok) {
      onEvent(
        decoded.result === response.result
          ? payload
          : {
              type: 'response',
              response: { ...response, result: decoded.result }
            }
      )
      return
    }
    // End the stream on decode failure so the window resubscribes from a full snapshot.
    onEvent({
      type: 'response',
      response: {
        id: response.id,
        ok: false,
        error: {
          code: SESSION_TABS_DELTA_OUT_OF_SYNC_ERROR,
          message: 'session tabs delta did not match the previous frame'
        },
        _meta: response._meta
      }
    })
  }
}
