// Grok's subagents, read as roster updates. Recorded from Grok 1.0.46 (s7 fixtures): a spawn is
// `spawn_subagent`, and Grok reports the child on the parent session as `subagent_spawned`,
// `subagent_progress` and `subagent_finished`. The subagent id is also the child's own session id.

import { z } from 'zod'
import type { AgentJournalToolCallItem } from '../../../shared/agent-session-journal-types'
import type { NativeChatSubagentState } from '../../../shared/native-chat-types'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import type { AcpSubagentUpdate } from './acp-dialect'
import { grokTaskResults, isGrokSubagentTask } from './grok-background-tasks'

const tokenCount = z.number().int().nonnegative()
const idSchema = z.string().trim().min(1)
const spawnedSchema = z.looseObject({
  sessionUpdate: z.literal('subagent_spawned'),
  subagent_id: idSchema,
  parent_prompt_id: z.string().optional(),
  description: z.string().nullish(),
  subagent_type: z.string().nullish()
})
const progressSchema = z.looseObject({
  sessionUpdate: z.literal('subagent_progress'),
  subagent_id: idSchema,
  tokens_used: tokenCount.optional()
})
const finishedSchema = z.looseObject({
  sessionUpdate: z.literal('subagent_finished'),
  subagent_id: idSchema,
  status: z.string(),
  output: z.string().nullish(),
  tokens_used: tokenCount.optional()
})
const spawnInputSchema = z.looseObject({
  description: z.string().optional(),
  prompt: z.string().optional()
})
const completedSpawnSchema = z.looseObject({
  type: z.literal('SubagentCompleted'),
  subagent_id: idSchema,
  output: z.string().nullish()
})
const spawnAckSchema = z.looseObject({ type: z.literal('Text'), text: z.string() })
const killInputSchema = z.object({
  task_id: idSchema.optional(),
  task_ids: z.array(idSchema).optional()
})
/** The id line of the reply a background spawn returns at once. */
const SPAWN_ACK_ID = /^subagent_id:\s*(\S+)\s*$/m
/** Machine blocks Grok appends to a subagent's reply for the parent model. */
const MACHINE_BLOCKS = /<subagent_(meta|result)>[\s\S]*?<\/subagent_\1>/g
const MAX_PROMPT_LABEL_CHARS = 80

/** Grok's statuses in the roster's words; a Map so `__proto__` resolves to nothing. */
const SUBAGENT_STATES: ReadonlyMap<string, NativeChatSubagentState> = new Map([
  ['completed', 'completed'],
  ['success', 'completed'],
  ['failed', 'failed'],
  ['error', 'failed'],
  ['cancelled', 'stopped'],
  ['killed', 'stopped'],
  ['stopped', 'stopped'],
  ['pending', 'working'],
  ['running', 'working']
] satisfies [string, NativeChatSubagentState][])

function subagentState(status: string | undefined): NativeChatSubagentState | undefined {
  return status === undefined ? undefined : SUBAGENT_STATES.get(status)
}

function replyText(output: string | null | undefined): string | undefined {
  return output?.replace(MACHINE_BLOCKS, '').trim() || undefined
}

function promptLabel(prompt: string | undefined): string | undefined {
  const line = prompt?.trim().split('\n')[0]?.trim()
  return line && line.length > MAX_PROMPT_LABEL_CHARS
    ? `${line.slice(0, MAX_PROMPT_LABEL_CHARS - 1)}…`
    : line || undefined
}

/** A `subagent_*` session update; undefined for any other update. */
export function grokSubagentNotification(update: unknown): AcpSubagentUpdate | undefined {
  const spawned = spawnedSchema.safeParse(update)
  if (spawned.success) {
    const { subagent_id, parent_prompt_id, description, subagent_type } = spawned.data
    const label = description?.trim() || subagent_type?.trim()
    return {
      id: subagent_id,
      state: 'working',
      ...(label ? { label } : {}),
      ...(parent_prompt_id ? { turn: parent_prompt_id } : {})
    }
  }
  const progress = progressSchema.safeParse(update)
  if (progress.success) {
    const tokens = progress.data.tokens_used
    return { id: progress.data.subagent_id, ...(tokens ? { tokens } : {}) }
  }
  const finished = finishedSchema.safeParse(update)
  if (!finished.success) {
    return undefined
  }
  const state = subagentState(finished.data.status)
  const result = state === 'completed' ? replyText(finished.data.output) : undefined
  // A cancelled subagent reports 0 tokens; the count it reported running stands.
  const tokens = finished.data.tokens_used
  return {
    id: finished.data.subagent_id,
    ...(state ? { state } : {}),
    ...(tokens ? { tokens } : {}),
    ...(result ? { result } : {})
  }
}

function spawnUpdates(update: ToolCallUpdate, tool: AgentJournalToolCallItem): AcpSubagentUpdate[] {
  const input = spawnInputSchema.safeParse(tool.input).data
  const label = input?.description?.trim() || promptLabel(input?.prompt)
  const named = label ? { label } : {}
  const completed = completedSpawnSchema.safeParse(update.rawOutput)
  if (completed.success) {
    const result = replyText(completed.data.output)
    return [
      {
        id: completed.data.subagent_id,
        state: 'completed',
        ...named,
        ...(result ? { result } : {})
      }
    ]
  }
  const ack = spawnAckSchema.safeParse(update.rawOutput)
  const id = ack.success ? SPAWN_ACK_ID.exec(ack.data.text)?.[1] : undefined
  return id ? [{ id, state: 'working', ...named }] : []
}

/** What a finished tool call says about subagents: its spawn's end or start, an output read, or a
 *  kill. Reads and kills name tasks of any kind, so they settle only subagents already known. */
export function grokToolSubagents(
  update: ToolCallUpdate,
  tool: AgentJournalToolCallItem
): AcpSubagentUpdate[] {
  if (update.status !== 'completed') {
    return []
  }
  if (tool.name === 'spawn_subagent') {
    return spawnUpdates(update, tool)
  }
  const results = grokTaskResults(update.rawOutput)
  if (results) {
    return results.tasks.flatMap((task): AcpSubagentUpdate[] => {
      if (!isGrokSubagentTask(task)) {
        return []
      }
      const state =
        results.type === 'KillTask'
          ? task.outcome === 'killed'
            ? 'stopped'
            : undefined
          : subagentState(task.status)
      const result = state === 'completed' ? replyText(task.output) : undefined
      return state
        ? [{ id: task.task_id, state, knownOnly: true, ...(result ? { result } : {}) }]
        : []
    })
  }
  const kill = killInputSchema.safeParse(tool.input)
  if (tool.name !== 'kill_command_or_subagent' || !kill.success) {
    return []
  }
  // Inference, as for background tasks: a successful kill ends the tasks it named.
  return [
    ...new Set([...(kill.data.task_ids ?? []), ...(kill.data.task_id ? [kill.data.task_id] : [])])
  ].map((id) => ({ id, state: 'stopped', knownOnly: true }))
}
