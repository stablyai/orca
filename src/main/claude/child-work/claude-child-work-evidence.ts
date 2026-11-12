import { ORCA_ORCHESTRATION_WAIT_COMMAND } from '../../../shared/orca-cli-invocations'
import type {
  AgentChildWorkKind,
  AgentChildWorkOperation,
  AgentChildWorkOutcome
} from '../../../shared/agent-status/child-work/agent-status-child-work'
import type {
  AgentChildWorkEvidence,
  AgentChildWorkLiveObservation
} from '../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import { taskText, taskUsageTotalTokens } from '../background-tasks/claude-background-task-frames'
import type {
  ClaudeSession,
  ClaudeStructuredSessionAdapterDeps
} from '../structured/claude-structured-session-state'
import type { ClaudeStructuredSessionEvent } from '../structured/claude-structured-session-event'
import { deriveToolInputPreview } from '../../../shared/agent-hook-listener/tool-input-preview'
import {
  claudeRecord,
  claudeToolResultId,
  claudeToolUses,
  readClaudeMessageEnvelope,
  type ClaudeToolUse
} from '../structured/journal/claude-structured-item-translation'

export type EndedClaudeTask = {
  run: string | undefined
  outcome: AgentChildWorkOutcome
  task?: DecodedClaudeTask
}

export type DecodedClaudeTask = {
  kind: AgentChildWorkKind
  backgrounded: boolean
  /** Monitors stay monitoring until the provider reports them running. */
  running: boolean
  name?: string
  description?: string
  toolUseId?: string
  parentTaskId?: string
  /** Runs `orca orchestration check --wait`: waiting on worker agents, so agent work. */
  awaitsAgents?: true
}

export function claudeChildWorkObservation(
  id: string,
  task: DecodedClaudeTask,
  facts: ClaudeTaskFacts,
  observedAt: number,
  waiting: boolean
): AgentChildWorkLiveObservation {
  const operation: AgentChildWorkOperation | undefined = facts.toolName
    ? { toolName: facts.toolName, basis: 'reported', observedAt }
    : task.awaitsAgents
      ? {
          toolName: 'Bash',
          input: ORCA_ORCHESTRATION_WAIT_COMMAND,
          basis: 'reported',
          observedAt
        }
      : undefined
  return {
    handle: {
      idKind: 'task_id',
      id,
      ...(task.toolUseId !== undefined ? { runId: task.toolUseId } : {})
    },
    ...(task.parentTaskId ? { ownerId: task.parentTaskId } : {}),
    kind: task.kind,
    residency: task.backgrounded ? 'background' : 'foreground',
    state: waiting ? 'waiting' : task.running || task.kind !== 'monitor' ? 'working' : 'monitoring',
    ...(task.name ? { name: task.name, agentType: task.name } : {}),
    ...(task.description ? { description: task.description } : {}),
    ...(facts.totalTokens !== undefined ? { totalTokens: facts.totalTokens } : {}),
    ...(operation ? { operation } : {}),
    ...(facts.lastMessage ? { lastMessage: facts.lastMessage } : {}),
    // Only background tasks expose a stop target.
    stoppable: task.backgrounded
  }
}

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
    if (child.ownerId !== undefined) {
      return child
    }
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

/** Publish child records after the frame's journal rows and parent record. */
export function claudeChildWorkPublisher(
  sessions: ReadonlyMap<string, ClaudeSession>,
  deps: Pick<ClaudeStructuredSessionAdapterDeps, 'onChildWorkEvidence' | 'now'>
) {
  return (
    sessionId: string,
    session: ClaudeSession | null | undefined = sessions.get(sessionId),
    message: Record<string, unknown> | null = null
  ): void => {
    const evidence = drainClaudeChildWork(session, message, deps.now?.() ?? Date.now())
    if (evidence.length > 0) {
      deps.onChildWorkEvidence?.(sessionId, evidence, session?.events)
    }
  }
}
