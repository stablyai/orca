import { mainAgentStatusEqual } from '../../../shared/main-agent-status'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { EnrichedAgentHookEventPayload } from './server-types'

/** The shell fact a Claude row stores beside its `mainAgent`; restart seeds a settled main agent only
 *  when it reads `false`. The listener restates it on every event it produces; any other write keeps
 *  the previous fact only while `mainAgent` is unchanged, since the fact was observed with that one. */
export function pairedClaudeNonAgentWork(
  previous: EnrichedAgentHookEventPayload | undefined,
  next: AgentHookEventPayload
): boolean | undefined {
  if (next.claudeRunningNonAgentTask !== undefined) {
    return next.claudeRunningNonAgentTask
  }
  return previous && mainAgentStatusEqual(previous.payload.mainAgent, next.payload.mainAgent)
    ? previous.claudeRunningNonAgentTask
    : undefined
}
