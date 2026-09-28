import {
  canReplaceBackgroundTaskState,
  isSettledBackgroundTaskState
} from '../../shared/native-chat-background-task-row'
import type { NativeChatBackgroundTaskBlock } from '../../shared/native-chat-types'
import type { ClaudeSubagentIds } from './claude-subagent-id-aliases'
import {
  classifyClaudeBackgroundTaskKind,
  liveClaudeTaskRunState,
  record,
  taskAliasId,
  taskDescription,
  taskId,
  taskName,
  taskText,
  taskUsageTotalTokens,
  terminalClaudeTaskRunState
} from './claude-background-task-frames'

export type ClaudeBackgroundTaskRow = {
  block: NativeChatBackgroundTaskBlock
  lastSerialized: string | null
  /** Immutable alias for persistence/coalescing; the final frame may enrich the block's parent. */
  toolUseId?: string
  /** Whether the provider's terminal notification finalized this run. */
  terminalNotificationReceived: boolean
  /** Which RUN of this task id the row records. 1 for the first. */
  generation: number
}

export type ClaudeBackgroundTaskChange = {
  state?: NativeChatBackgroundTaskBlock['state'] | null
  label?: string | undefined
  kind?: NativeChatBackgroundTaskBlock['kind'] | undefined
  summary?: string | undefined
  error?: string | undefined
  outputFile?: string | undefined
  tokens?: number | undefined
}

export function canonicalClaudeBackgroundTaskId(
  message: Record<string, unknown>,
  ids: ClaudeSubagentIds
): string | null {
  const declared = taskId(message)
  const toolUseId = claudeBackgroundTaskToolUseId(message)
  if (declared === null) {
    const aliased = toolUseId === undefined ? null : ids.canonical(toolUseId)
    return aliased !== null && aliased !== toolUseId ? aliased : null
  }
  if (toolUseId !== undefined) {
    ids.alias(toolUseId, declared)
  }
  return declared
}

export function claudeBackgroundTaskToolUseId(
  message: Record<string, unknown>
): string | undefined {
  const patch = record(message.patch)
  return taskAliasId(message.tool_use_id) ?? taskAliasId(patch?.tool_use_id)
}

export function claudeBackgroundTaskNotificationChange(
  message: Record<string, unknown>
): ClaudeBackgroundTaskChange {
  return {
    state: terminalClaudeTaskRunState(message.status) ?? 'done',
    summary: taskText(message.summary),
    error: taskText(message.error),
    outputFile: taskText(message.output_file),
    tokens: taskUsageTotalTokens(message)
  }
}

export function claudeBackgroundTaskPatchChange(
  message: Record<string, unknown>
): ClaudeBackgroundTaskChange {
  const patch = record(message.patch) ?? message
  const status = patch.status ?? message.status
  const terminal = terminalClaudeTaskRunState(status)
  return {
    state: terminal ?? liveClaudeTaskRunState(status),
    label:
      message.subtype === 'task_progress'
        ? undefined
        : (taskDescription(patch.description) ?? taskName(patch)),
    kind: 'task_type' in patch ? classifyClaudeBackgroundTaskKind(patch.task_type) : undefined,
    error: taskText(patch.error),
    tokens: taskUsageTotalTokens(message)
  }
}

export function newClaudeBackgroundTaskRow(
  id: string,
  message: Record<string, unknown>,
  now: number,
  generation: number
): ClaudeBackgroundTaskRow {
  const totalTokens = taskUsageTotalTokens(message)
  const toolUseId = claudeBackgroundTaskToolUseId(message)
  return {
    lastSerialized: null,
    terminalNotificationReceived: false,
    generation,
    ...(toolUseId === undefined ? {} : { toolUseId }),
    block: {
      type: 'background-task',
      taskId: id,
      kind: classifyClaudeBackgroundTaskKind(message.task_type),
      label: taskDescription(message.description) ?? taskName(message) ?? '',
      ...(toolUseId === undefined ? {} : { parentToolUseId: toolUseId }),
      state:
        terminalClaudeTaskRunState(message.status) ??
        liveClaudeTaskRunState(message.status) ??
        'working',
      startedAt: now,
      ...(totalTokens === undefined ? {} : { tokens: totalTokens })
    }
  }
}

/** The row a terminal notification opens on its own.
 *
 *  A terminal frame is self-sufficient: it states an outcome the transcript owes
 *  the user whether or not an announcement ever admitted the task, so the row is
 *  built from the frame's own fields — its summary as the sentence, its status as
 *  the state, its error, output path and usage. */
export function newClaudeBackgroundTaskRowFromNotification(
  id: string,
  message: Record<string, unknown>,
  now: number,
  generation: number
): ClaudeBackgroundTaskRow {
  const row = newClaudeBackgroundTaskRow(id, message, now, generation)
  finalizeClaudeBackgroundTaskRow(row, message, now)
  return row
}

/** A status patch is provisional; the notification supplies the final verdict. */
export function finalizeClaudeBackgroundTaskRow(
  row: ClaudeBackgroundTaskRow,
  message: Record<string, unknown>,
  now: number
): void {
  reviseClaudeBackgroundTaskRow(row, claudeBackgroundTaskNotificationChange(message), now)
  const notificationToolUseId = claudeBackgroundTaskToolUseId(message)
  row.block = {
    ...row.block,
    ...(row.block.parentToolUseId === undefined && notificationToolUseId !== undefined
      ? { parentToolUseId: notificationToolUseId }
      : {}),
    state: terminalClaudeTaskRunState(message.status) ?? 'done',
    settledAt: now
  }
  row.terminalNotificationReceived = true
}

export function shouldRestartClaudeBackgroundTaskRow(
  row: ClaudeBackgroundTaskRow,
  message: Record<string, unknown>
): boolean {
  if (!isSettledBackgroundTaskState(row.block.state) || row.block.startedAt === undefined) {
    return false
  }
  const toolUseId = claudeBackgroundTaskToolUseId(message)
  // One rule for a restart, the same one the terminal ledger applies to a row
  // that has already been evicted: only when BOTH runs name their parent is a
  // different alias the provider's restart signal. A finished run that named no
  // parent cannot be proved distinct from this announcement, so it stands.
  const parentToolUseId = row.block.parentToolUseId
  return parentToolUseId !== undefined && toolUseId !== undefined && toolUseId !== parentToolUseId
}

/** Task types the transcript materializes as a row.
 *
 *  Type is the whole gate. A MONITOR is never admitted: it is Claude's own
 *  ambient housekeeping, runs for the life of the session, and has no outcome a
 *  transcript row could report. A type this build does not recognise is not
 *  evidence of anything a row could truthfully say either. Agents are
 *  materialized too, by the subagent roster, which claims them upstream of this
 *  owner — so the set left here is the backgrounded shell command and the
 *  workflow. */
const MATERIALIZED_TASK_KINDS: ReadonlySet<NativeChatBackgroundTaskBlock['kind']> = new Set([
  'command',
  'workflow'
])

export function isClaudeBackgroundTranscriptTask(
  message: Record<string, unknown>,
  kind: NativeChatBackgroundTaskBlock['kind']
): boolean {
  // A task the provider explicitly calls foreground is the turn's own work and
  // already has the tool row that invoked it.
  return MATERIALIZED_TASK_KINDS.has(kind) && message.is_backgrounded !== false
}

export function reviseClaudeBackgroundTaskRow(
  row: ClaudeBackgroundTaskRow,
  change: ClaudeBackgroundTaskChange,
  now: number
): void {
  const next: NativeChatBackgroundTaskBlock = { ...row.block }
  if (change.label && !next.label) {
    next.label = change.label
  }
  if (change.kind !== undefined && change.kind !== 'unknown') {
    next.kind = change.kind
  }
  if (change.summary !== undefined) {
    next.summary = change.summary
  }
  if (change.error !== undefined) {
    next.error = change.error
  }
  if (change.outputFile !== undefined) {
    next.outputFile = change.outputFile
  }
  if (change.tokens !== undefined) {
    next.tokens = change.tokens
  }
  if (change.state && canReplaceBackgroundTaskState(next.state, change.state)) {
    next.state = change.state
    if (isSettledBackgroundTaskState(change.state)) {
      next.settledAt = now
    }
  }
  row.block = next
}
