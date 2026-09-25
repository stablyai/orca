// Claude child work as the host records it: the outcome vocabulary, what a progress frame says,
// the owner of each child through the journal's own linkage, which children a pending request
// blocks, and the tool a child has open.
// The task frames themselves are read by `claude-child-work-decoder`; everything here is drained
// after the journal handled the frame, so the host never admits evidence ahead of its rows.

import type { AgentChildWorkOutcome } from '../../shared/agent-status-child-work'
import type {
  AgentChildWorkEvidence,
  AgentChildWorkLiveObservation
} from '../../shared/agent-status-child-work-evidence'
import { taskText, taskUsageTotalTokens } from './claude-background-task-frames'
import type { ClaudePendingPrompt } from './claude-prompt-registry'
import type { ClaudeSession } from './claude-structured-session-state'
import { deriveToolInputPreview } from '../../shared/agent-hook-listener/tool-input-preview'
import {
  claudeToolResults,
  claudeToolUses,
  readClaudeMessageEnvelope,
  type ClaudeToolUse
} from './claude-structured-item-translation'

export type ClaudeTaskFacts = {
  /** The tool the provider last reported; stamped at drain. */
  toolName?: string
  lastMessage?: string
  totalTokens?: number
}

/** Provider status → how the child ended. `killed` and `stopped` are deliberate stops; a status
 *  a terminal frame does not state is an ending nobody classified, never a success. */
export function claudeChildWorkOutcome(status: unknown): AgentChildWorkOutcome {
  switch (status) {
    case 'completed':
      return 'succeeded'
    case 'failed':
      return 'failed'
    case 'killed':
    case 'stopped':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

/** What a `task_progress` frame says: the tool the child last ran, its newest summary, usage.
 *  Its `description` restates the tool ("Running Bash") and is not the task's own. */
export function claudeTaskProgressFacts(message: Record<string, unknown>): ClaudeTaskFacts {
  const toolName = taskText(message.last_tool_name)
  const lastMessage = taskText(message.summary)
  const totalTokens = taskUsageTotalTokens(message)
  return {
    ...(toolName ? { toolName } : {}),
    ...(lastMessage ? { lastMessage } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {})
  }
}

/** Name the child that owns each live child: the agent whose own traffic made the spawn (or
 *  shell) call. A call the session's own agent made has no owner. */
export function withClaudeChildWorkOwners(
  evidence: AgentChildWorkEvidence[],
  ownerOf: ((toolUseId: string) => string | null) | undefined
): AgentChildWorkEvidence[] {
  if (!ownerOf) {
    return evidence
  }
  const owned = (child: AgentChildWorkLiveObservation): AgentChildWorkLiveObservation => {
    const ownerId = child.handle.runId === undefined ? null : ownerOf(child.handle.runId)
    return ownerId !== null && ownerId !== child.handle.id ? { ...child, ownerId } : child
  }
  return evidence.map((edge) =>
    edge.type === 'live' ? { ...edge, child: owned(edge.child) } : edge
  )
}

/**
 * A child's own tool traffic, read after the journal handled the frame: the call the child has
 * open now, previewed as a hook-reported row previews its own tool. A frame that only delivers
 * the caller's own spawn result belongs to the caller, not the child it names.
 */
export function claudeChildOperation(
  message: Record<string, unknown>,
  activityOf:
    | ((parentToolUseId: string) => { agentId: string; openTool: ClaudeToolUse | null })
    | undefined,
  observedAt: number
): AgentChildWorkEvidence[] {
  const envelope = activityOf ? readClaudeMessageEnvelope(message) : null
  const parentRef = envelope?.parentToolUseId
  if (!envelope || !parentRef || !activityOf) {
    return []
  }
  const toolTraffic =
    claudeToolUses(envelope).length > 0 ||
    claudeToolResults(envelope).some((result) => result.toolUseId !== parentRef)
  if (!toolTraffic) {
    return []
  }
  const { agentId, openTool } = activityOf(parentRef)
  const input = openTool ? deriveToolInputPreview(openTool.name, openTool.input) : undefined
  return [
    {
      type: 'operation',
      observedAt,
      childId: agentId,
      operation: openTool
        ? { toolName: openTool.name, ...(input ? { input } : {}), basis: 'open', observedAt }
        : null
    }
  ]
}

/** The children blocked on a request the provider is still waiting on an answer to: the subagent
 *  the request names, or, from a CLI that names none, the child that owns the tool call it gates. */
export function claudeWaitingChildIds(
  prompts: Iterable<ClaudePendingPrompt>,
  ownerOf: ((toolUseId: string) => string | null) | undefined
): Set<string> {
  const waiting = new Set<string>()
  for (const prompt of prompts) {
    const childId = prompt.agentId ?? ownerOf?.(prompt.toolUseId) ?? null
    if (childId !== null) {
      waiting.add(childId)
    }
  }
  return waiting
}

/** Everything one frame (or a close) said about the session's child work, owners named. */
export function drainClaudeChildWork(
  session: Pick<ClaudeSession, 'childWork' | 'translator' | 'prompts'> | null | undefined,
  message: Record<string, unknown> | null,
  observedAt: number
): AgentChildWorkEvidence[] {
  if (!session) {
    return []
  }
  const ownerOf = session.translator?.childToolOwner
  // Re-derived from the pending requests on every drain, so no wait outlives its request.
  session.childWork.observeWaiting(claudeWaitingChildIds(session.prompts.pending(), ownerOf))
  return [
    ...withClaudeChildWorkOwners(session.childWork.drain(observedAt), ownerOf),
    ...(message ? claudeChildOperation(message, session.translator?.childActivity, observedAt) : [])
  ]
}
