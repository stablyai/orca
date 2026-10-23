// Claude's declarative task protocol, read for which tasks are subagents and which ids name them.
//
// `local_agent`, `local_workflow` and `local_bash` tasks all arrive on the same
// `message:system:task_*` channel and ALL carry a `tool_use_id`, so id presence
// discriminates nothing: filtering on it alone puts a backgrounded `sleep 20` in
// the subagent roster. `task_type` is the discriminator, with `subagent_type`
// covering CLI releases that predate it.

import {
  classifyClaudeBackgroundTaskKind,
  claudeTaskId,
  isBoundedClaudeTaskId
} from './claude-background-task-tracker'
import { isAgentChildWorkKind } from '../../shared/agent-status-child-work-liveness'
import { claudeRecord, claudeText } from './claude-structured-item-translation'

const TASK_SUBTYPES: ReadonlySet<string> = new Set([
  'task_started',
  'task_updated',
  'task_progress',
  'task_notification'
])

export type ClaudeSubagentTaskFrame = {
  /** Canonical, resume-stable id. */
  taskId: string
  /** Re-minted when Claude re-announces a resumed task, so it is only an alias. */
  toolUseId: string | null
  /** `task_started` for a subagent. Only an announcement says what a task is: an update carries
   *  no `task_type`. */
  announcesSubagent: boolean
  /** Ambient housekeeping, or a task that is not a subagent at all. Its ids must never be read as
   *  a subagent's, by this frame or by later child traffic. */
  excluded: boolean
}

/** True when the task Claude announced is a subagent rather than a backgrounded
 *  shell command or a workflow. */
export function isClaudeSubagentTask(message: Record<string, unknown>): boolean {
  if (isAgentChildWorkKind(classifyClaudeBackgroundTaskKind(message.task_type))) {
    return true
  }
  // Releases predating `task_type` still name the child in `subagent_type`. A
  // task_type Orca does not recognise is NOT covered: it is a type this build
  // has no reason to believe is an agent.
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
  // Housekeeping Claude runs for itself; the user never asked for it.
  const suppressed = message.ambient === true || message.skip_transcript === true
  const subagent = announcement && !suppressed && isClaudeSubagentTask(message)
  return {
    taskId,
    toolUseId: toolUseId && isBoundedClaudeTaskId(toolUseId) ? toolUseId : null,
    announcesSubagent: subagent,
    excluded: announcement && !subagent
  }
}
