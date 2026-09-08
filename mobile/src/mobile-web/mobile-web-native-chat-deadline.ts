import { MOBILE_WEB_NATIVE_CHAT_MAX_DEADLINE_AHEAD_MS } from '../../../src/shared/mobile-web/native-chat-operation-contract'
import { MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS } from '../session/mobile-native-chat-send'
import { MobileWebBrokerError } from './mobile-web-broker-error'

export function validateMobileWebNativeChatDeadline(deadline: number): void {
  const remainingMs = deadline - Date.now()
  if (
    remainingMs < MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS ||
    remainingMs > MOBILE_WEB_NATIVE_CHAT_MAX_DEADLINE_AHEAD_MS
  ) {
    throw new MobileWebBrokerError('invalid_request')
  }
}
