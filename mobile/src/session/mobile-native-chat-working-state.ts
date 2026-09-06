import type { NativeChatTurnLifecycle } from '../../../src/shared/native-chat-types'
import type { MobileNativeChatAgentStatusWithProvider } from './mobile-native-chat-eligibility'

export function isMobileNativeChatAgentWorking(
  status: MobileNativeChatAgentStatusWithProvider | null | undefined,
  lifecycle: NativeChatTurnLifecycle | undefined
): boolean {
  // Why: a monitoring agent is working without holding the foreground — showing the busy
  // indicator, Stop, and a live streaming bubble for it misreports what it is doing.
  if (status?.state !== 'working' || status.workingMode === 'monitoring') {
    return false
  }
  if (!lifecycle || lifecycle.state === 'working') {
    return true
  }
  const stateStartedAt = status.stateStartedAt
  if (
    lifecycle.timestamp === null ||
    !Number.isFinite(lifecycle.timestamp) ||
    !Number.isSafeInteger(stateStartedAt) ||
    stateStartedAt === undefined ||
    stateStartedAt < 0
  ) {
    return true
  }
  return lifecycle.timestamp < stateStartedAt
}
