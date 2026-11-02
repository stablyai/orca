import { mainAgentStatusEqual } from '../../../shared/main-agent-status'
import {
  claudeTeammateIdMatchesName,
  isClaudeChildTurnEndEvent
} from '../../../shared/claude-subagent-roster'
import { isAskUserQuestionTool } from '../../../shared/agent-question-answered-intent'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import {
  isClaudePermissionSettledByReplay,
  isSameClaudeReplayRun
} from '../../../shared/agent-hook-listener/claude-settled-permission-requests'
import type { EnrichedAgentHookEventPayload } from './server-types'

/** Retain the shell-work fact only with the main-agent observation that established it. */
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

/** Keep main-agent progress behind a child's permission prompt so restart cannot settle live work. */
export function withHeldChildWaitMainAgent(
  previous: EnrichedAgentHookEventPayload,
  next: AgentHookEventPayload
): EnrichedAgentHookEventPayload {
  const mainAgent = next.payload.mainAgent
  if (!previous.toolAgentId || !mainAgent) {
    return previous
  }
  const runningNonAgentTask = pairedClaudeNonAgentWork(previous, next)
  const mainAgentChanged = !mainAgentStatusEqual(previous.payload.mainAgent, mainAgent)
  const pendingWakeup = next.payload.claudeTaskWakeupPending
  const wakeupChanged = pendingWakeup !== previous.payload.claudeTaskWakeupPending
  if (
    !mainAgentChanged &&
    !wakeupChanged &&
    runningNonAgentTask === previous.claudeRunningNonAgentTask
  ) {
    return previous
  }
  const { claudeRunningNonAgentTask: _unpaired, ...unpaired } = previous
  return {
    ...unpaired,
    ...(runningNonAgentTask !== undefined
      ? { claudeRunningNonAgentTask: runningNonAgentTask }
      : {}),
    payload:
      mainAgentChanged || wakeupChanged
        ? { ...previous.payload, mainAgent, claudeTaskWakeupPending: pendingWakeup }
        : previous.payload
  }
}

type ClaudeSettlementEvidence = Pick<
  AgentHookEventPayload,
  | 'hookEventName'
  | 'toolUseId'
  | 'claudeBatchSettledRequests'
  | 'connectionId'
  | 'toolAgentId'
  | 'isReplay'
  | 'launchToken'
  | 'providerSession'
>

/** The bound tool use's own start or end, or batch evidence listing it, from the same owner. */
function endsBoundClaudePermission(
  previous: AgentHookEventPayload,
  next: ClaudeSettlementEvidence
): boolean {
  const toolUseId = previous.toolUseId?.trim()
  const owner = previous.toolAgentId?.trim() || undefined
  if (!toolUseId) {
    return false
  }
  // A replay carries the relay's recent batch settlements beside whatever row it restates.
  const batch =
    next.isReplay === true
      ? isSameClaudeReplayRun(previous, next)
        ? next.claudeBatchSettledRequests
        : undefined
      : next.hookEventName === 'PostToolBatch' && previous.connectionId === next.connectionId
        ? next.claudeBatchSettledRequests
        : undefined
  if (batch?.some((request) => request.toolUseId === toolUseId && request.toolAgentId === owner)) {
    return true
  }
  return (
    previous.connectionId === next.connectionId &&
    owner === (next.toolAgentId?.trim() || undefined) &&
    (next.hookEventName === 'PreToolUse' ||
      next.hookEventName === 'PostToolUse' ||
      next.hookEventName === 'PostToolUseFailure') &&
    next.toolUseId?.trim() === toolUseId
  )
}

/** A live batch only ever settles a held bound request; anything else is main's no-op and never becomes the row. */
export function isUnusedClaudeSettlement(
  previous: AgentHookEventPayload | undefined,
  next: ClaudeSettlementEvidence & Pick<AgentHookEventPayload, 'isReplay'>
): boolean {
  return (
    next.hookEventName === 'PostToolBatch' &&
    next.isReplay !== true &&
    !(
      previous?.claudePermissionBound &&
      previous.payload.state === 'waiting' &&
      endsBoundClaudePermission(previous, next)
    )
  )
}

export function shouldKeepClaudePermissionVisible(
  previous: EnrichedAgentHookEventPayload | undefined,
  next: AgentHookEventPayload
): boolean {
  if (previous?.restoredUnconfirmed) {
    return false
  }
  if (
    previous?.payload.agentType !== 'claude' ||
    previous.payload.state !== 'waiting' ||
    previous.hookEventName !== 'PermissionRequest' ||
    next.payload.agentType !== 'claude' ||
    next.payload.state !== 'working'
  ) {
    return false
  }
  if (next.hasExplicitPrompt === true) {
    return false
  }
  if (isClaudePermissionOwningChildEnding(previous, next)) {
    return false
  }
  if (isClaudePermissionSettledByReplay(previous, next)) {
    return false
  }
  if (previous.claudePermissionBound) {
    // A request naming its tool use waits for that use's own settlement; sibling previews never end it.
    return !endsBoundClaudePermission(previous, next)
  }
  if (isClaudePermissionResumingApprovedTool(previous, next)) {
    return false
  }
  // AskUserQuestion can arrive as PermissionRequest; only actual permissions stay sticky.
  if (isAskUserQuestionTool(previous.payload.toolName)) {
    return false
  }
  return true
}

function isClaudePermissionOwningChildEnding(
  previous: EnrichedAgentHookEventPayload,
  next: AgentHookEventPayload
): boolean {
  const ownerId = previous.toolAgentId?.trim()
  if (!ownerId) {
    return false
  }
  if (isClaudeChildTurnEndEvent(next.hookEventName, next.toolAgentId)) {
    return ownerId === next.toolAgentId?.trim()
  }
  return (
    next.hookEventName === 'TeammateIdle' &&
    next.teammateName !== undefined &&
    claudeTeammateIdMatchesName(ownerId, next.teammateName)
  )
}

function isClaudePermissionResumingApprovedTool(
  previous: EnrichedAgentHookEventPayload,
  next: AgentHookEventPayload
): boolean {
  const previousToolUseId = previous.toolUseId?.trim() || undefined
  const nextToolUseId = next.toolUseId?.trim() || undefined
  const previousAgentId = previous.toolAgentId?.trim() || undefined
  const nextAgentId = next.toolAgentId?.trim() || undefined
  const hasAgentId = previousAgentId !== undefined || nextAgentId !== undefined
  const previousAgentType = previous.toolAgentType?.trim() || undefined
  const nextAgentType = next.toolAgentType?.trim() || undefined
  const hasMatchingConcreteAgentId =
    previousAgentId !== undefined && previousAgentId === nextAgentId
  const hasSameExplicitAgentType =
    !hasAgentId && previousAgentType !== undefined && previousAgentType === nextAgentType
  const sameToolName =
    previous.payload.toolName !== undefined && previous.payload.toolName === next.payload.toolName
  const sameKnownToolInput =
    previous.payload.toolInput !== undefined &&
    previous.payload.toolInput === next.payload.toolInput
  const sameUnknownInputFromConcreteAgent =
    hasMatchingConcreteAgentId &&
    previous.payload.toolInput === undefined &&
    next.payload.toolInput === undefined
  const hasMatchingToolUseId =
    previousToolUseId !== undefined && previousToolUseId === nextToolUseId
  const hasConflictingToolUseId =
    previousToolUseId !== undefined &&
    nextToolUseId !== undefined &&
    previousToolUseId !== nextToolUseId
  const sameUnknownInputFromToolUseId =
    hasMatchingToolUseId &&
    previous.payload.toolInput === undefined &&
    next.payload.toolInput === undefined

  // Failure clears tool name/input; require the exact request and owner.
  if (next.hookEventName === 'PostToolUseFailure') {
    return (
      hasMatchingToolUseId && previousAgentId === nextAgentId && previousAgentType === nextAgentType
    )
  }

  return (
    (next.hookEventName === 'PreToolUse' || next.hookEventName === 'PostToolUse') &&
    nextToolUseId !== undefined &&
    !hasConflictingToolUseId &&
    // Subagents share agent_type; concrete agent or tool-use IDs distinguish them.
    (hasMatchingConcreteAgentId || hasSameExplicitAgentType || hasMatchingToolUseId) &&
    sameToolName &&
    (sameKnownToolInput || sameUnknownInputFromConcreteAgent || sameUnknownInputFromToolUseId)
  )
}

export function shouldInheritClaudeToolUseIdForPermission(
  previous: EnrichedAgentHookEventPayload | undefined,
  next: AgentHookEventPayload
): boolean {
  if (
    previous?.restoredUnconfirmed ||
    previous?.payload.agentType !== 'claude' ||
    previous.payload.state !== 'working' ||
    previous.hookEventName !== 'PreToolUse' ||
    typeof previous.toolUseId !== 'string' ||
    previous.toolUseId.trim().length === 0 ||
    next.payload.agentType !== 'claude' ||
    next.payload.state !== 'waiting' ||
    next.hookEventName !== 'PermissionRequest' ||
    next.toolUseId !== undefined
  ) {
    return false
  }
  const sameKnownToolInput =
    previous.payload.toolInput !== undefined &&
    previous.payload.toolInput === next.payload.toolInput
  const sameUnknownToolInput =
    previous.payload.toolInput === undefined && next.payload.toolInput === undefined
  if (
    previous.toolAgentId !== next.toolAgentId ||
    previous.toolAgentType !== next.toolAgentType ||
    previous.payload.toolName === undefined ||
    previous.payload.toolName !== next.payload.toolName ||
    (!sameKnownToolInput && !sameUnknownToolInput)
  ) {
    return false
  }
  return true
}

export function attachClaudePermissionToolUseId(
  previous: EnrichedAgentHookEventPayload | undefined,
  next: AgentHookEventPayload
): AgentHookEventPayload {
  if (
    next.payload.agentType === 'claude' &&
    next.payload.state === 'waiting' &&
    next.hookEventName === 'PermissionRequest' &&
    next.toolUseId?.trim() &&
    !isAskUserQuestionTool(next.payload.toolName)
  ) {
    // The provider omits the id; a producer supplies it only for its single matching in-flight call.
    return { ...next, claudePermissionBound: true }
  }
  const inheritedToolUseId = previous?.toolUseId
  if (
    !shouldInheritClaudeToolUseIdForPermission(previous, next) ||
    typeof inheritedToolUseId !== 'string'
  ) {
    return next
  }
  return {
    ...next,
    // PermissionRequest omits tool_use_id; PostToolUse reuses the PreToolUse ID.
    toolUseId: inheritedToolUseId
  }
}
