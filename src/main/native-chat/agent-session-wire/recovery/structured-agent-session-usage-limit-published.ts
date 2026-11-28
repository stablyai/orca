import type { AgentSessionUsageLimitContinue } from '../../../../shared/agent-session/lifecycle/stopping/agent-session-usage-limit-continue-wire'
import type { UsageLimitAccountVerdict } from './structured-agent-session-usage-limit-account-types'

/** A usage-limited chat's continue as the host publishes it on the status summary. */
export function publishedUsageLimitContinue(
  cut: { turnItemId: string; resetsAt: number },
  hold: UsageLimitAccountVerdict,
  state: AgentSessionUsageLimitContinue['state']
): AgentSessionUsageLimitContinue {
  return {
    turnItemId: cut.turnItemId,
    resetsAt: cut.resetsAt,
    // While the reset is unknown, `hold.resetsAt` is a reading time, not a reset.
    ...(!hold.unknownReset && hold.resetsAt !== cut.resetsAt ? { continueAt: hold.resetsAt } : {}),
    ...(hold.limitedAccount !== undefined ? { limitedAccount: hold.limitedAccount } : {}),
    state
  }
}
