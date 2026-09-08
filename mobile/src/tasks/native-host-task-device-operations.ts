import { MOBILE_WEB_NATIVE_CAPABILITY_AUTHORITY } from '../mobile-web/mobile-web-native-capability-authority'
import type { HostTaskDeviceOperations } from './host-task-device-operations'

export const nativeHostTaskDeviceOperations: HostTaskDeviceOperations = {
  async copyText(text) {
    await MOBILE_WEB_NATIVE_CAPABILITY_AUTHORITY.clipboardWrite(text)
  },
  hapticMediumImpact() {
    MOBILE_WEB_NATIVE_CAPABILITY_AUTHORITY.hapticFeedback('medium-impact')
  },
  openExternalUrl(url) {
    return MOBILE_WEB_NATIVE_CAPABILITY_AUTHORITY.openExternal(url)
  }
}
