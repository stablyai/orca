import type { ConnectionState } from '../../transport/types'
import {
  isMobileNativeChatAgentConfirmed,
  type MobileNativeChatTab
} from './mobile-native-chat-eligibility'
import type { MobileNativeChatInputLockReason } from './MobileNativeChatView'

export function mobileNativeChatOverlayInputLockReason(
  tab: MobileNativeChatTab | null,
  connState: ConnectionState,
  leaseLockReason: MobileNativeChatInputLockReason | null
): MobileNativeChatInputLockReason | null {
  if (tab?.type === 'agent-session') {
    return connState === 'connected' ? null : 'disconnected'
  }
  // Why: a chat only this phone remembers may sit on a bare shell; never type into it.
  return leaseLockReason ?? (isMobileNativeChatAgentConfirmed(tab) ? null : 'waiting')
}
