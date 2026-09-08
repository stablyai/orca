import { router } from 'expo-router'
import type { HostSessionDeviceOperations } from './host-session-device-operations'
import { MOBILE_WEB_NATIVE_CAPABILITY_AUTHORITY } from '../mobile-web/mobile-web-native-capability-authority'

export const nativeHostSessionDeviceOperations: HostSessionDeviceOperations = {
  hapticFeedback(kind) {
    MOBILE_WEB_NATIVE_CAPABILITY_AUTHORITY.hapticFeedback(kind)
  },
  clipboardAvailability() {
    return MOBILE_WEB_NATIVE_CAPABILITY_AUTHORITY.clipboardAvailability()
  },
  copyText(text) {
    return MOBILE_WEB_NATIVE_CAPABILITY_AUTHORITY.clipboardWrite(text)
  },
  openExternalUrl(url) {
    return MOBILE_WEB_NATIVE_CAPABILITY_AUTHORITY.openExternal(url)
  },
  openTerminalSettings() {
    router.push('/terminal-settings')
  },
  loadTerminalPreferences() {
    return MOBILE_WEB_NATIVE_CAPABILITY_AUTHORITY.terminalPreferences()
  },
  loadTerminalAccessoryPreferences() {
    return MOBILE_WEB_NATIVE_CAPABILITY_AUTHORITY.terminalAccessoryPreferences!()
  },
  saveTerminalCustomKeys(customKeys) {
    return MOBILE_WEB_NATIVE_CAPABILITY_AUTHORITY.terminalCustomKeysUpdate!(customKeys)
  },
  saveTerminalTextScale(textScale) {
    return MOBILE_WEB_NATIVE_CAPABILITY_AUTHORITY.terminalTextScaleUpdate(textScale)
  }
}
