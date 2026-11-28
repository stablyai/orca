import {
  isNativeChatUsageLimitCutSchedulable,
  type NativeChatUsageLimitCut
} from '../../../../shared/native-chat/transcript/continuation/native-chat-usage-limit-cut'
import { switchFreeIdentity, type SwitchReset } from './structured-agent-session-usage-limit-chain'

type Move = { cut: string; at: number }

export function withMovedCutReset<T extends NativeChatUsageLimitCut>(
  moved: Move | undefined,
  cut: T
): T & SwitchReset {
  return cut.resetsAt === undefined && moved?.cut === switchFreeIdentity(cut)
    ? { ...cut, resetsAt: moved.at, resetFromSwitch: true }
    : cut
}

export function isAccountHoldSchedulable(
  cut: NativeChatUsageLimitCut & SwitchReset,
  now: number,
  verdict: (cut: NativeChatUsageLimitCut & { resetsAt: number } & SwitchReset) => {
    resetsAt: number
  }
): cut is NativeChatUsageLimitCut & { resetsAt: number; turnEndedAt: number } {
  return (
    isNativeChatUsageLimitCutSchedulable(cut, Number.NEGATIVE_INFINITY) &&
    isNativeChatUsageLimitCutSchedulable({ ...cut, ...verdict(cut) }, now)
  )
}
