import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  type MobileWebBridgeMessageContext
} from '../../../src/shared/mobile-web/bridge-contract'

export function mobileWebBrokerEnvelope(context: MobileWebBridgeMessageContext) {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    shellSessionId: context.shellSessionId,
    buildId: context.buildId
  } as const
}
