import type { AgentChildWorkKind } from '../../../shared/agent-status/child-work/agent-status-child-work'
// Task IDs alone cannot distinguish agents from shells or workflows; task_type identifies the kind.

import { classifyClaudeBackgroundTaskKind } from '../../../shared/claude-background-task-kind'
import {
  taskId as claudeTaskId,
  isBoundedClaudeTaskId
} from '../background-tasks/claude-background-task-frames'
import { isAgentChildWorkKind } from '../../../shared/agent-status/child-work/agent-status-child-work-liveness'
import { claudeRecord, claudeText } from '../structured/journal/claude-structured-item-translation'

const TASK_SUBTYPES: ReadonlySet<string> = new Set([
  'task_started',
  'task_updated',
  'task_progress',
  'task_notification'
])

export type ClaudeSubagentTaskFrame = {
  /** Canonical, resume-stable ID. */
  taskId: string
  /** Resumes mint new tool IDs, making each an alias. */
  toolUseId: string | null
  /** Only task_started establishes kind; later updates may omit task_type. */
  announcesSubagent: boolean
  /** Remember non-agent and housekeeping exclusions for later frames. */
  excluded: boolean
}

export function isClaudeSubagentTask(message: Record<string, unknown>): boolean {
  if (isAgentChildWorkKind(classifyClaudeBackgroundTaskKind(message.task_type))) {
    return true
  }
  // Older releases use subagent_type; never apply that fallback to an unknown explicit task_type.
  return (
    (message.task_type === undefined || message.task_type === null) &&
    claudeText(message.subagent_type) !== null
  )
}

export function readClaudeSubagentTaskFrame(
  message: Record<string, unknown>
): ClaudeSubagentTaskFrame | null {
  if (message.type !== 'system') {
    return null
  }
  const subtype = claudeText(message.subtype)
  if (!subtype || !TASK_SUBTYPES.has(subtype)) {
    return null
  }
  const taskId = claudeTaskId(message)
  if (!taskId) {
    return null
  }
  const toolUseId =
    claudeText(message.tool_use_id) ?? claudeText(claudeRecord(message.patch)?.tool_use_id)
  const announcement = subtype === 'task_started'
  const suppressed = message.ambient === true || message.skip_transcript === true
  const subagent = announcement && !suppressed && isClaudeSubagentTask(message)
  return {
    taskId,
    toolUseId: toolUseId && isBoundedClaudeTaskId(toolUseId) ? toolUseId : null,
    announcesSubagent: subagent,
    excluded: announcement && !subagent
  }
}

/** Releases predating `task_type` still name an agent in `subagent_type`. */
export function claudeStartedTaskKind(message: Record<string, unknown>): AgentChildWorkKind {
  return isClaudeSubagentTask(message)
    ? 'agent'
    : classifyClaudeBackgroundTaskKind(message.task_type)
}
