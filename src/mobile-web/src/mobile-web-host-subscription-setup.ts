import {
  MobileWebHostRequestPayloadSchema,
  MobileWebHostResultSchema,
  type MobileWebHostRequestPayload
} from '../../shared/mobile-web/host-rpc-contract'
import type { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebBridgeSubscriptionSetup } from './mobile-web-bridge-subscription-setup'

export function isMobileWebHostSubscriptionEnd(event: unknown): boolean {
  return (
    typeof event === 'object' &&
    event !== null &&
    'type' in event &&
    (event.type === 'end' || event.type === 'error')
  )
}

export function hostSubscriptionSetup(
  payload: MobileWebHostRequestPayload,
  onEvent: (event: unknown) => void,
  onError: (error: MobileWebBridgeClientError) => void
): MobileWebBridgeSubscriptionSetup {
  return {
    capability: 'workspace',
    operation: 'hostSubscribe',
    payload,
    payloadSchema: MobileWebHostRequestPayloadSchema,
    eventSchema: MobileWebHostResultSchema,
    onEvent,
    onError
  }
}
