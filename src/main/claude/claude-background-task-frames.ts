// Field readers for the Claude SDK's background-task lifecycle frames
// (task_started / task_updated / task_notification / background_tasks_changed).
// Pure and bounded: every reader rejects absent, non-string, or oversized
// values so a malformed frame degrades to "field unknown", never to a throw.

import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskRunState
} from '../../shared/agent-session-wire'

const MAX_TASK_ID_LENGTH = 512
const MAX_TASK_TEXT_LENGTH = 512

export type ClaudeBackgroundTaskKind = AgentSessionBackgroundTask['kind']

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/** The bound every task id shares, wherever it enters. An id the roster stores
 *  becomes a durable entry key, so a provisional one takes the same bound the
 *  announced path applies — an over-long id is rejected, never truncated. */
export function isBoundedClaudeTaskId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_TASK_ID_LENGTH
}

export function taskId(message: Record<string, unknown>): string | null {
  const value = message.task_id
  return typeof value === 'string' && isBoundedClaudeTaskId(value) ? value : null
}

function boundedTaskText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim().replace(/\s+/g, ' ')
  return trimmed.length > 0 ? trimmed.slice(0, MAX_TASK_TEXT_LENGTH) : undefined
}

export function taskDescription(value: unknown): string | undefined {
  return boundedTaskText(value)
}

/** The provider-reported identity for a task. Subagent frames have carried the
 *  type under both `agent_type` and `subagent_type` across SDK versions. */
export function taskName(frame: Record<string, unknown>): string | undefined {
  return (
    boundedTaskText(frame.name) ??
    boundedTaskText(frame.agent_type) ??
    boundedTaskText(frame.subagent_type)
  )
}

export function classifyClaudeBackgroundTaskKind(taskType: unknown): ClaudeBackgroundTaskKind {
  switch (taskType) {
    case 'local_agent':
      return 'agent'
    case 'local_workflow':
      return 'workflow'
    case 'local_bash':
      return 'command'
    case 'monitor':
      return 'monitor'
    default:
      return 'unknown'
  }
}

/** Cumulative token usage from a task_progress / task_notification frame. */
export function taskUsageTotalTokens(frame: Record<string, unknown>): number | undefined {
  const usage = record(frame.usage)
  const total = usage?.total_tokens
  return typeof total === 'number' && Number.isFinite(total) && total >= 0
    ? Math.floor(total)
    : undefined
}

/** Settled state for a terminal status. Null for anything else — an unreadable
 *  status never settles a task by itself. */
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

/** Live state for a non-terminal status. Null leaves the tracked state alone. */
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
