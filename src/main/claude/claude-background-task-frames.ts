import { classifyClaudeBackgroundTaskKind } from '../../shared/claude-background-task-kind'
import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskRunState
} from '../../shared/agent-session-wire'
import { ownRetainedString } from '../../shared/own-retained-string'

const MAX_TASK_ID_LENGTH = 512
const MAX_TASK_TEXT_LENGTH = 512

export type ClaudeBackgroundTaskKind = AgentSessionBackgroundTask['kind']
export { classifyClaudeBackgroundTaskKind }

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

// Reject oversized durable IDs rather than truncating them into collisions.
export function isBoundedClaudeTaskId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_TASK_ID_LENGTH
}

export function taskId(message: Record<string, unknown>): string | null {
  const value = message.task_id
  return typeof value === 'string' && isBoundedClaudeTaskId(value) ? value : null
}

export function taskAliasId(value: unknown): string | undefined {
  return typeof value === 'string' && isBoundedClaudeTaskId(value) ? value : undefined
}

function boundedTaskText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim().replace(/\s+/g, ' ')
  return trimmed.length > 0 ? ownRetainedString(trimmed.slice(0, MAX_TASK_TEXT_LENGTH)) : undefined
}

export function taskDescription(value: unknown): string | undefined {
  return boundedTaskText(value)
}

export function taskText(value: unknown): string | undefined {
  return boundedTaskText(value)
}

// SDK versions use both agent_type and subagent_type for the same identity.
export function taskName(frame: Record<string, unknown>): string | undefined {
  return (
    boundedTaskText(frame.name) ??
    boundedTaskText(frame.agent_type) ??
    boundedTaskText(frame.subagent_type)
  )
}

export function taskUsageTotalTokens(frame: Record<string, unknown>): number | undefined {
  const usage = record(frame.usage)
  const total = usage?.total_tokens
  return typeof total === 'number' && Number.isFinite(total) && total >= 0
    ? Math.floor(total)
    : undefined
}

export function terminalClaudeTaskRunState(
  status: unknown
): AgentSessionBackgroundTaskRunState | null {
  switch (status) {
    case 'completed':
      return 'done'
    case 'failed':
      return 'blocked'
    case 'killed':
    case 'stopped':
      return 'idle'
    default:
      return null
  }
}

export function liveClaudeTaskRunState(status: unknown): AgentSessionBackgroundTaskRunState | null {
  switch (status) {
    case 'pending':
    case 'running':
    case 'paused':
      return 'working'
    default:
      return null
  }
}
