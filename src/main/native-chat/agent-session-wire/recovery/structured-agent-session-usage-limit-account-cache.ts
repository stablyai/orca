import type { NativeChatUsageLimitCut } from '../../../../shared/native-chat/transcript/continuation/native-chat-usage-limit-cut'
import type { AgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { switchFreeIdentity } from './structured-agent-session-usage-limit-chain'
import type { SwitchReset } from './structured-agent-session-usage-limit-chain'
import { withMovedCutReset } from './structured-agent-session-usage-limit-account-schedule'
import type { UsageLimitAccountScope } from './structured-agent-session-usage-limit-account-types'
import type { UsageLimitRelaunchedCuts } from './structured-agent-session-usage-limit-relaunch'

export function accountSwitchReset<T extends NativeChatUsageLimitCut>(
  id: string,
  cut: T,
  moved: ReadonlyMap<string, { cut: string; to: AgentSessionAccountHome; at: number }>,
  relaunched: UsageLimitRelaunchedCuts
): T & SwitchReset {
  const at = relaunched.at(id, switchFreeIdentity(cut))
  return withMovedCutReset(
    moved.get(id) ?? (at ? { cut: switchFreeIdentity(cut), at } : undefined),
    cut
  )
}

export function accountSwitchRoom(
  id: string,
  cut: NativeChatUsageLimitCut & SwitchReset,
  providers: ReadonlyMap<string, string>,
  scopes: ReadonlyMap<string, UsageLimitAccountScope | undefined>,
  relaunched: UsageLimitRelaunchedCuts,
  now: number
): void {
  relaunched.askForRoom({
    id,
    cut,
    provider: providers.get(id),
    scope: scopes.get(id),
    now
  })
}
