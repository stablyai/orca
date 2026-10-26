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
  toolName?: string
  lastMessage?: string
  totalTokens?: number
}

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

/** Ownership follows the spawn call; the session agent has no child owner. */
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

/** The caller's spawn result is not the child's own tool operation. */
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

/** Waiting requires both a written journal card and a registry request still awaiting an answer. */
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

/** Wait for deferred sinks to write the prompt card. */
export function claudePromptCardWritten(
  session: Pick<ClaudeSession, 'translator'> | null | undefined,
  event: ClaudeStructuredSessionEvent
): Promise<void> | undefined {
  return event.type === 'prompt'
    ? session?.translator?.journalPrompts.whenWritten(event.prompt.promptKey)
    : undefined
}

/** Drain after journaling the frame; stamp evidence with the host clock. */
export function drainClaudeChildWork(
  session: Pick<ClaudeSession, 'childWork' | 'translator' | 'prompts'> | null | undefined,
  message: Record<string, unknown> | null,
  observedAt: number
): AgentChildWorkEvidence[] {
  if (!session) {
    return []
  }
  // Recheck cards and answer state so waits end when a card closes or its answer starts.
  session.childWork.observeWaiting(claudeWaitingChildIds(session))
  return [
    ...withClaudeChildWorkOwners(
      session.childWork.drain(observedAt),
      session.translator?.childToolOwner
    ),
    ...(message ? claudeChildOperation(message, session.translator?.childActivity, observedAt) : [])
  ]
}
