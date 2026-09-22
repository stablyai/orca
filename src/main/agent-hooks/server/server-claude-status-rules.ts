import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { EnrichedAgentHookEventPayload } from './server-types'

export function attachClaudeChildOnlyBoundary(
  previous: EnrichedAgentHookEventPayload | undefined,
  next: AgentHookEventPayload
): AgentHookEventPayload & { claudeLeadBoundaryChildOnly?: true } {
  const establishesBoundary =
    next.payload.agentType === 'claude' &&
    (next.hookEventName === 'Stop' || next.hookEventName === 'StopFailure') &&
    !next.toolAgentId &&
    next.payload.state === 'working' &&
    next.payload.subagents?.some((subagent) => subagent.state === 'working') === true &&
    next.claudeRunningNonAgentTask === false
  const carriesBoundary =
    previous?.claudeLeadBoundaryChildOnly === true &&
    next.payload.agentType === 'claude' &&
    next.claudeRunningNonAgentTask === false &&
    (next.toolAgentId !== undefined ||
      next.hookEventName === 'SubagentStart' ||
      next.hookEventName === 'SubagentStop' ||
      next.hookEventName === 'TeammateIdle')
  return establishesBoundary || carriesBoundary
    ? { ...next, claudeLeadBoundaryChildOnly: true }
    : next
}

export function invalidateClaudeChildOnlyBoundary(
  previous: EnrichedAgentHookEventPayload | undefined,
  next: AgentHookEventPayload
): EnrichedAgentHookEventPayload | undefined {
  if (
    previous?.claudeLeadBoundaryChildOnly !== true ||
    attachClaudeChildOnlyBoundary(previous, next).claudeLeadBoundaryChildOnly === true
  ) {
    return previous
  }
  const { claudeLeadBoundaryChildOnly: _boundary, ...withoutBoundary } = previous
  return withoutBoundary
}
