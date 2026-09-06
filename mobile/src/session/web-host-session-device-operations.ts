import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { HostSessionDeviceOperations } from './host-session-device-operations'

export function webHostSessionDeviceOperations(
  client: MobileWebBridgeClient
): HostSessionDeviceOperations {
  return {
    hapticFeedback(kind) {
      void client.native.hapticFeedback(kind).catch(() => {})
    },
    clipboardAvailability() {
      return client.native.clipboardAvailability()
    },
    copyText(text) {
      return client.native.clipboardWrite(text)
    },
    async openExternalUrl(url) {
      await client.native.openExternal(url)
    },
    openTerminalSettings() {
      void client.navigationRoute({ destination: 'terminalSettings' }).catch(() => {})
    },
    loadTerminalPreferences() {
      return client.native.terminalPreferences()
    },
    loadTerminalAccessoryPreferences() {
      return client.native.terminalAccessoryPreferences()
    },
    async saveTerminalCustomKeys(customKeys) {
      await client.native.terminalCustomKeysUpdate(customKeys)
    },
    async saveTerminalTextScale(textScale) {
      await client.native.terminalTextScaleUpdate(textScale)
    }
  }
}
