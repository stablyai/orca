import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { HookListenerState } from '../../../shared/agent-hook-listener/listener-state'
import {
  attachClaudePermissionToolUseId,
  claudeBatchSettlesRequest,
  holdClaudeRequest,
  pairedClaudeNonAgentWork,
  resumeClaudeRequestLead,
  shouldKeepClaudePermissionVisible
} from '../../../shared/agent-hook-listener/claude-permission-transition'
import { isOrdinaryClaudeRequest } from '../../../shared/agent-hook-listener/claude-permission-host-rules'

/** A projected row was already decided by its execution host; this server decides only its own hooks. */
export function attachLocalClaudeToolUseId(
  previous: AgentHookEventPayload | undefined,
  admitted: AgentHookEventPayload
): AgentHookEventPayload {
  return admitted.claudePermission ? admitted : attachClaudePermissionToolUseId(previous, admitted)
}

/**
 * This server's permission transition over one row: `held` is the request it keeps showing, else
 * `next` applies. `admitted` is the row before the cancel latch; its projection and host decide
 * who rules, since this server is the execution host only for its own panes.
 */
export function decideLocalClaudePermission<T extends AgentHookEventPayload>(
  state: HookListenerState,
  previous: T | undefined,
  event: AgentHookEventPayload,
  admitted: Pick<AgentHookEventPayload, 'claudePermission' | 'connectionId'>
): { held?: T; next: AgentHookEventPayload } {
  const projection = admitted.claudePermission
  const host = admitted.connectionId === null ? state : undefined
  const next =
    host && claudeBatchSettlesRequest(previous, event) && previous
      ? resumeClaudeRequestLead(state, previous, event)
      : event
  if (
    previous &&
    (projection
      ? // A bare marker vouches only for the request a receiver already shows, never another row.
        projection.held === true && !projection.row && isOrdinaryClaudeRequest(previous)
      : shouldKeepClaudePermissionVisible(previous, next, host))
  ) {
    return { held: holdClaudeRequest(previous, next, !!host || !!projection), next }
  }
  return { next }
}

/** The row this server stores once it applies `next`: terminal joins hold only within one host, and
 *  settlement lists, batches and projections vouch only for this transition. */
export function storedClaudeTransitionRow(
  previous: AgentHookEventPayload | undefined,
  next: AgentHookEventPayload
) {
  const {
    claudeRunningNonAgentTask: _unpaired,
    claudeSettledRequests: _settled,
    claudeBatch: _batch,
    claudePermission: _projection,
    ...unpaired
  } = next
  const runningNonAgentTask = pairedClaudeNonAgentWork(previous, next)
  return runningNonAgentTask === undefined
    ? unpaired
    : { ...unpaired, claudeRunningNonAgentTask: runningNonAgentTask }
}
