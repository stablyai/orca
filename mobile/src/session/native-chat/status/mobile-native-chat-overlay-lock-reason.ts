import type { ConnectionState } from '../../../transport/connection/connection-state'
import {
  isMobileNativeChatAgentConfirmed,
  type MobileNativeChatTab
} from '../conversation/mobile-native-chat-eligibility'
import type { MobileNativeChatInputLockReason } from '../MobileNativeChatView'

export function mobileNativeChatOverlayInputLockReason(
  tab: MobileNativeChatTab | null,
  connState: ConnectionState,
  leaseLockReason: MobileNativeChatInputLockReason | null,
  agentExited = false
): MobileNativeChatInputLockReason | null {
  if (tab?.type === 'agent-session') {
    return connState === 'connected' ? null : 'disconnected'
  }
  // Why: a chat only this phone remembers may sit on a bare shell; never type into it.
  if (leaseLockReason) {
    return leaseLockReason
  }
  if (!isMobileNativeChatAgentConfirmed(tab)) {
    return 'waiting'
  }
  return agentExited ? 'agent-exited' : null
}
