// Field readers for the Claude SDK's background-task lifecycle frames
// (task_started / task_updated / task_notification / background_tasks_changed).
// Pure and bounded: every reader rejects absent, non-string, or oversized
// values so a malformed frame degrades to "field unknown", never to a throw.

import { classifyClaudeBackgroundTaskKind } from '../../shared/claude-background-task-kind'
import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskRunState
} from '../../shared/agent-session-wire'
import { backgroundTaskFallbackText } from '../../shared/native-chat-background-task-row'
import { ownRetainedString } from '../../shared/own-retained-string'

const MAX_TASK_ID_LENGTH = 512
const MAX_TASK_TEXT_LENGTH = 512

export type ClaudeBackgroundTaskKind = AgentSessionBackgroundTask['kind']
export { classifyClaudeBackgroundTaskKind }

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

/** Every other provider string a durable task row carries — its summary, its
 *  error, its output path — takes the description bound: the row is replayed on
 *  every reconnect, and each reader clips it again anyway. */
export function taskText(value: unknown): string | undefined {
  return boundedTaskText(value)
}

/**
 * The sentence a task frame wrote about itself.
 *
 * Only for a frame the row owner could not claim — malformed or capacity-refused.
 * It reaches the generic fallback, which has no key for `summary` and would
 * otherwise print the bare opcode. Passed to that fallback as Claude's own
 * display text rather than taught to its shared key list, because that list is
 * read for every provider and already resolves `summary` by hand for two Codex
 * methods; widening it globally to reach one malformed Claude frame would
 * re-rank the row text of every unmodelled frame on both providers.
 */
export function taskFrameSentence(frame: Record<string, unknown>): string | undefined {
  const patch = record(frame.patch)
  const sentence =
    taskText(frame.summary) ??
    taskText(frame.error) ??
    taskText(patch?.summary) ??
    taskText(patch?.error)
  if (sentence) {
    return sentence
  }

  // A terminal task update often carries only its status in the nested patch.
  // Reuse the durable row's frozen sentence so capacity fallbacks never expose
  // the provider opcode when no human-facing text was supplied.
  if (
    frame.subtype !== 'task_started' &&
    frame.subtype !== 'task_updated' &&
    frame.subtype !== 'task_progress' &&
    frame.subtype !== 'task_notification'
  ) {
    return undefined
  }
  const status = patch?.status ?? frame.status
  const state = terminalClaudeTaskRunState(status)
  if (state === null) {
    return undefined
  }
  const kind = classifyClaudeBackgroundTaskKind(patch?.task_type ?? frame.task_type)
  return backgroundTaskFallbackText({
    type: 'background-task',
    taskId: taskId(frame) ?? '',
    kind,
    label:
      taskDescription(patch?.description) ??
      taskDescription(frame.description) ??
      (patch ? taskName(patch) : undefined) ??
      taskName(frame) ??
      '',
    state
  })
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
