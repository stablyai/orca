import { z } from 'zod'
import type { AgentJournalToolCallItem } from '../../../shared/agent-session-journal-types'
import {
  isSettledBackgroundTaskState,
  normalizeBackgroundTaskKind
} from '../../../shared/native-chat-background-task-row'
import type { NativeChatBackgroundTaskBlock } from '../../../shared/native-chat-types'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import type { AcpBackgroundTaskUpdate, AcpDialectNotification } from './acp-dialect'

const taskSchema = z.object({
  task_id: z.string().min(1),
  command: z.string().optional(),
  description: z.string().nullish(),
  monitor_description: z.string().nullish(),
  display_command: z.string().nullish(),
  output_file: z.string().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  output: z.string().optional(),
  kind: z.string().optional(),
  task_type: z.string().optional(),
  exit_code: z.number().int().nullish(),
  signal: z.union([z.string(), z.number()]).nullish(),
  explicitly_killed: z.boolean().optional()
})
const backgroundedSchema = taskSchema.extend({
  sessionUpdate: z.literal('task_backgrounded'),
  tool_call_id: z.string().optional()
})
const completedSchema = z.object({
  sessionUpdate: z.literal('task_completed'),
  task_snapshot: taskSchema
})
const startedOutputSchema = taskSchema.extend({ type: z.literal('BackgroundTaskStarted') })
const taskResultSchema = taskSchema.extend({
  status: z.string().optional(),
  outcome: z.string().optional()
})
const resultOutputSchema = z.object({
  type: z.enum(['TaskOutput', 'KillTask']),
  Result: taskResultSchema.optional(),
  MultiResult: z.object({ results: z.array(taskResultSchema) }).optional()
})
type GrokTask = z.infer<typeof taskSchema>
export type GrokTaskResult = z.infer<typeof taskResultSchema>
/** Grok's output reads name a monitor only by this command prefix. */
const MONITOR_COMMAND = /^\[monitor[:\]]/
/** ...and a subagent by this one; subagents are roster rows, not background tasks. */
const SUBAGENT_COMMAND = /^\[subagent[:\]]/

export function isGrokSubagentTask(task: Pick<GrokTask, 'command'>): boolean {
  return SUBAGENT_COMMAND.test(task.command ?? '')
}

/** The per-task results of a finished output read or kill call. */
export function grokTaskResults(
  rawOutput: unknown
): { type: 'TaskOutput' | 'KillTask'; tasks: GrokTaskResult[] } | undefined {
  const result = resultOutputSchema.safeParse(rawOutput)
  return result.success
    ? {
        type: result.data.type,
        tasks: result.data.MultiResult?.results ?? (result.data.Result ? [result.data.Result] : [])
      }
    : undefined
}

function completedState(task: GrokTask): NativeChatBackgroundTaskBlock['state'] {
  return task.explicitly_killed
    ? 'idle'
    : task.signal != null || task.error?.trim() || (task.exit_code != null && task.exit_code !== 0)
      ? 'blocked'
      : 'done'
}

function resultState(
  task: z.infer<typeof taskResultSchema>
): NativeChatBackgroundTaskBlock['state'] | undefined {
  if (task.explicitly_killed || ['killed', 'stopped', 'cancelled'].includes(task.status ?? '')) {
    return 'idle'
  }
  if (task.error?.trim() || ['failed', 'error'].includes(task.status ?? '')) {
    return 'blocked'
  }
  if (
    task.exit_code != null ||
    task.signal != null ||
    ['completed', 'success', 'succeeded'].includes(task.status ?? '')
  ) {
    return completedState(task)
  }
  return ['pending', 'running'].includes(task.status ?? '') ? 'working' : undefined
}

function snapshot(
  task: GrokTask,
  state: NativeChatBackgroundTaskBlock['state']
): AcpBackgroundTaskUpdate {
  const kind = task.kind ?? task.task_type
  const monitor =
    kind === 'monitor' ||
    task.monitor_description != null ||
    MONITOR_COMMAND.test(task.command ?? '')
  const label = task.monitor_description?.trim() || task.description?.trim()
  const fallbackLabel = task.display_command?.trim() || task.command?.trim()
  const settled = isSettledBackgroundTaskState(state)
  return {
    taskId: task.task_id,
    state,
    ...(monitor
      ? { kind: 'monitor' as const }
      : kind !== undefined
        ? {
            kind:
              kind === 'bash' || kind === 'shell' || task.command !== undefined
                ? ('command' as const)
                : normalizeBackgroundTaskKind(kind)
          }
        : task.command !== undefined
          ? { fallbackKind: 'command' as const }
          : {}),
    ...(label ? { label } : fallbackLabel ? { fallbackLabel } : {}),
    ...(task.output_file === undefined ? {} : { outputFile: task.output_file }),
    // A running task's summary is Grok's "Background task <id> started", not the task's result.
    ...(settled ? { summary: task.summary ?? '' } : {}),
    ...(task.error === undefined && !settled ? {} : { error: task.error ?? '' })
  }
}

const taskInputSchema = z.object({
  description: z.string().optional(),
  command: z.string().optional(),
  task_id: z.string().trim().min(1).optional(),
  task_ids: z.array(z.string().trim().min(1)).optional()
})

export function grokToolBackgroundTasks(
  update: ToolCallUpdate,
  tool: AgentJournalToolCallItem
): AcpBackgroundTaskUpdate[] {
  const result = grokTaskResults(update.rawOutput)
  if (result) {
    return result.tasks.flatMap((task) => {
      if (isGrokSubagentTask(task)) {
        return []
      }
      if (result.type === 'KillTask') {
        return update.status === 'completed' && task.outcome === 'killed'
          ? [snapshot(task, 'idle')]
          : []
      }
      const state = resultState(task)
      return state ? [snapshot(task, state)] : []
    })
  }
  const input = taskInputSchema.safeParse(tool.input)
  if (tool.name === 'kill_command_or_subagent' && update.status === 'completed' && input.success) {
    // Inference: a successful kill call settles its named tasks without a completion notice.
    return [
      ...new Set([
        ...(input.data.task_ids ?? []),
        ...(input.data.task_id ? [input.data.task_id] : [])
      ])
    ].map((taskId) => ({ taskId, state: 'idle', summary: '', error: '' }))
  }
  const parsed = startedOutputSchema.safeParse(update.rawOutput)
  return parsed.success
    ? [
        {
          ...snapshot({ ...(input.success ? input.data : {}), ...parsed.data }, 'working'),
          parentToolUseId: update.toolCallId
        }
      ]
    : []
}

export function grokBackgroundTaskNotification(
  canonicalMethod: string,
  params: unknown
): AcpDialectNotification | undefined {
  if (!['x.ai/task_backgrounded', 'x.ai/task_completed'].includes(canonicalMethod)) {
    return undefined
  }
  const parsed = z
    .object({ sessionId: z.string(), update: z.union([backgroundedSchema, completedSchema]) })
    .safeParse(params)
  if (!parsed.success) {
    return { disposition: 'ignore' }
  }
  const update = parsed.data.update
  if (update.sessionUpdate === 'task_backgrounded') {
    return {
      disposition: 'map',
      backgroundTasks: [
        {
          ...snapshot(update, update.monitor_description != null ? 'monitoring' : 'working'),
          ...(update.tool_call_id === undefined ? {} : { parentToolUseId: update.tool_call_id })
        }
      ]
    }
  }
  const task = update.task_snapshot
  return { disposition: 'map', backgroundTasks: [snapshot(task, completedState(task))] }
}
