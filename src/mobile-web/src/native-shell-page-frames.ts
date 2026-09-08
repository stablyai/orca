import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  type MobileWebBridgeMessageContext,
  type MobileWebBridgePageMessage
} from '../../shared/mobile-web/bridge-contract'
import { hasMobileWebHardwareBackHandler } from './mobile-web-hardware-back-handler'

type MobileWebNativeWindow = Window & {
  OrcaNative?: Readonly<{ postMessage(value: string): void }>
}

export function postPageMessage(message: MobileWebBridgePageMessage): boolean {
  const nativeWindow = window as MobileWebNativeWindow
  if (!nativeWindow.OrcaNative) {
    return false
  }
  try {
    nativeWindow.OrcaNative.postMessage(JSON.stringify(message))
    return true
  } catch {
    return false
  }
}

export function postPageReady(context: MobileWebBridgeMessageContext): void {
  postPageMessage({
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    ...context,
    type: 'ready'
  })
  if (hasMobileWebHardwareBackHandler()) {
    postPageMessage({
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      ...context,
      type: 'hardwareBackCapability',
      revision: 1
    })
  }
}
