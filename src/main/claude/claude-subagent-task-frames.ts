// Claude's declarative task protocol, read as subagent roster events.
//
// `local_agent`, `local_workflow` and `local_bash` tasks all arrive on the same
// `message:system:task_*` channel and ALL carry a `tool_use_id`, so id presence
// discriminates nothing: filtering on it alone puts a backgrounded `sleep 20` in
// the subagent roster. `task_type` is the discriminator, with `subagent_type`
// covering CLI releases that predate it.

import type { NativeChatSubagentState } from '../../shared/native-chat-types'
import {
  classifyClaudeBackgroundTaskKind,
  claudeTaskDescription,
  claudeTaskId,
  isBoundedClaudeTaskId
} from './claude-background-task-tracker'
import { claudeRecord, claudeText } from './claude-structured-item-translation'

const TASK_SUBTYPES: ReadonlySet<string> = new Set([
  'task_started',
  'task_updated',
  'task_progress',
  'task_notification'
])

/** Provider status → the carrier's vocabulary. `killed` and `stopped` both mean
 *  the task was deliberately ended, which the carrier calls `stopped`; every
 *  in-flight status collapses to `working`. A Map, not an object, so a payload
 *  carrying `__proto__` as its status cannot resolve to an inherited value. */
const TASK_STATES: ReadonlyMap<string, NativeChatSubagentState> = new Map([
  ['pending', 'working'],
  ['running', 'working'],
  ['paused', 'working'],
  ['completed', 'completed'],
  ['failed', 'failed'],
  ['killed', 'stopped'],
  ['stopped', 'stopped']
] satisfies [string, NativeChatSubagentState][])

export type ClaudeSubagentTaskFrame = {
  /** Canonical, resume-stable id — the roster key. */
  taskId: string
  /** Re-minted when Claude re-announces a resumed task, so it is only an alias. */
  toolUseId: string | null
  label: string | null
  /** null when the frame reported no lifecycle status. */
  state: NativeChatSubagentState | null
  backgrounded: boolean | null
  /** Any `task_started`, subagent or not. Proof this CLI declares its tasks. */
  announcement: boolean
  /** `task_started` for a task the roster should show. Only an announcement
   *  creates an entry: an update carries no `task_type`, so honouring one for an
   *  unknown id would roster whatever else shares this channel. */
  announcesSubagent: boolean
  /** Ambient housekeeping, or a task that is not a subagent at all. Its ids must
   *  never reach the roster, by this frame or by later child traffic. */
  excluded: boolean
}

/** True when the task Claude announced is a subagent rather than a backgrounded
 *  shell command or a workflow. */
export function isClaudeSubagentTask(message: Record<string, unknown>): boolean {
  if (classifyClaudeBackgroundTaskKind(message.task_type) === 'agent') {
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

function taskState(value: unknown): NativeChatSubagentState | null {
  return typeof value === 'string' ? (TASK_STATES.get(value) ?? null) : null
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
  const patch = claudeRecord(message.patch)
  const toolUseId = claudeText(message.tool_use_id) ?? claudeText(patch?.tool_use_id)
  const announcement = subtype === 'task_started'
  // Housekeeping Claude runs for itself; the user never asked for it.
  const suppressed = message.ambient === true || message.skip_transcript === true
  const subagent = announcement && !suppressed && isClaudeSubagentTask(message)
  return {
    taskId,
    toolUseId: toolUseId && isBoundedClaudeTaskId(toolUseId) ? toolUseId : null,
    label:
      claudeTaskDescription(message.description) ??
      claudeTaskDescription(patch?.description) ??
      // Bounded like a description: the roster stores whatever this returns.
      (announcement ? (claudeTaskDescription(message.subagent_type) ?? null) : null),
    // Notifications carry terminal evidence; progress carries usage only.
    state:
      subtype === 'task_notification'
        ? taskState(message.status)
        : announcement || subtype === 'task_updated'
          ? taskState(patch?.status ?? message.status)
          : null,
    backgrounded:
      typeof patch?.is_backgrounded === 'boolean'
        ? patch.is_backgrounded
        : typeof message.is_backgrounded === 'boolean'
          ? message.is_backgrounded
          : null,
    announcement,
    announcesSubagent: subagent,
    excluded: announcement && !subagent
  }
}
