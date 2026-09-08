import {
  MOBILE_WEB_BRIDGE_MAX_PENDING_REQUESTS,
  MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS,
  type MobileWebBridgeShellMessage
} from '../../shared/mobile-web/bridge-contract'
import { encodedMobileWebBridgeValueByteLength } from './mobile-web-bridge-request-encoding'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'

type OperationGrant = Extract<MobileWebBridgeShellMessage, { type: 'init' }>['grants'][number]

export function mobileWebSubscriptionSetupError(args: {
  disposed: boolean
  grant: OperationGrant | undefined
  payloadValid: boolean
  payload: unknown
  pendingCount: number
  otherPendingCount: number
  activeCount: number
}): MobileWebBridgeClientError | null {
  if (args.disposed) {
    return new MobileWebBridgeClientError('cancelled', false)
  }
  if (!args.grant) {
    return new MobileWebBridgeClientError('unsupported_capability', false)
  }
  if (!args.payloadValid) {
    return new MobileWebBridgeClientError('invalid_request', false)
  }
  if (encodedMobileWebBridgeValueByteLength(args.payload) > args.grant.limits.maxRequestBytes) {
    return new MobileWebBridgeClientError('too_large', false)
  }
  if (
    args.pendingCount + args.otherPendingCount >= MOBILE_WEB_BRIDGE_MAX_PENDING_REQUESTS ||
    args.activeCount >= MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS
  ) {
    return new MobileWebBridgeClientError('rate_limited', true)
  }
  return null
}
