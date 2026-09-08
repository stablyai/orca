import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { HostTaskDeviceOperations } from './host-task-device-operations'

export function webHostTaskDeviceOperations(
  client: MobileWebBridgeClient
): HostTaskDeviceOperations {
  return {
    async copyText(text) {
      await client.native.clipboardWrite(text)
    },
    hapticMediumImpact() {
      void client.native.hapticFeedback('medium-impact').catch(() => {})
    },
    async openExternalUrl(url) {
      await client.native.openExternal(url)
    }
  }
}
