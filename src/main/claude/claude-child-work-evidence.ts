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
import type { ClaudeSession, ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import { deriveToolInputPreview } from '../../shared/agent-hook-listener/tool-input-preview'
import {
  claudeRecord,
  claudeToolResultId,
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
    envelope.content.some((value) => {
      const part = claudeRecord(value)
      const toolUseId = claudeToolResultId(part)
      return toolUseId !== null && toolUseId !== parentRef
    })
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

/** The subagents whose request is still open with no answer underway (the registry's fact) and
 *  whose card has landed (the journal's): a waiting child always sits beside its pending card, and
 *  its parent reads that card, never the child's wait. A request is claimed or forgotten in the
 *  registry before its card closes, so however it ends its child is freed first. */
function claudeWaitingChildIds(
  session: Pick<ClaudeSession, 'prompts' | 'translator'>
): Set<string> {
  const waiting = new Set<string>()
  for (const card of session.translator?.journalPrompts.openCards() ?? []) {
    if (session.prompts.awaitsAnswer(card.promptKey)) {
      waiting.add(card.asker)
    }
  }
  return waiting
}

/** Settles once the card a prompt event raised is written, for a sink that writes it later. */
export function claudePromptCardWritten(
  session: Pick<ClaudeSession, 'translator'> | null | undefined,
  event: ClaudeStructuredSessionEvent
): Promise<void> | undefined {
  return event.type === 'prompt'
    ? session?.translator?.journalPrompts.whenWritten(event.prompt.promptKey)
    : undefined
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
  // Re-derived from the open cards on every drain, so no wait outlives its card.
  session.childWork.observeWaiting(claudeWaitingChildIds(session))
  return [
    ...withClaudeChildWorkOwners(
      session.childWork.drain(observedAt),
      session.translator?.childToolOwner
    ),
    ...(message ? claudeChildOperation(message, session.translator?.childActivity, observedAt) : [])
  ]
}
