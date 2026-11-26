// OMP 19.1 reports its task subagents on the task call: `details.progress` while they run, and
// `details.results` once a blocking call returns. Its ids are unique within a session.
// Background subagents keep reporting on the call after it returned, in updates that no longer
// name the tool, so the task call is known by its details instead.

import { z } from 'zod'
import type { NativeChatSubagentState } from '../../../shared/native-chat/native-chat-types'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import type { AcpSubagentUpdate } from './acp-dialect'

const idSchema = z.string().trim().min(1)
const tokenCount = z.number().int().nonnegative()
const costSchema = z.number().nonnegative()
// Fields AgentProgress and SingleResult share.
const subagentFields = {
  id: idSchema,
  description: z.string().optional(),
  tokens: tokenCount.optional(),
  // Provider/id; `resolvedModel` may add a thinking suffix.
  resolvedModelIdentity: z.string().optional(),
  resolvedThinkingLevel: z.string().optional()
}
const progressSchema = z.looseObject({
  ...subagentFields,
  status: z.string(),
  cost: costSchema.optional()
})
const resultSchema = z.looseObject({
  ...subagentFields,
  exitCode: z.number().int(),
  output: z.string().optional(),
  error: z.string().optional(),
  aborted: z.boolean().optional(),
  usage: z.looseObject({ cost: z.looseObject({ total: costSchema }) }).optional()
})
const taskOutputSchema = z.looseObject({
  details: z.looseObject({
    projectAgentsDir: z.string().nullable(),
    progress: z.array(z.unknown()).optional(),
    results: z.array(z.unknown()).optional()
  })
})

// Map lookups avoid treating __proto__ as a recognized state.
const PROGRESS_STATES: ReadonlyMap<string, NativeChatSubagentState> = new Map([
  ['pending', 'working'],
  ['running', 'working'],
  ['completed', 'completed'],
  ['failed', 'failed'],
  ['aborted', 'stopped']
] satisfies [string, NativeChatSubagentState][])

function described(
  subagent: z.infer<z.ZodObject<typeof subagentFields>>,
  cost: number | undefined
): AcpSubagentUpdate {
  const { id, description, tokens, resolvedModelIdentity, resolvedThinkingLevel } = subagent
  // The row names the model, not the provider OMP routed it through.
  const model = resolvedModelIdentity?.split('/').at(-1)?.trim()
  const effort = resolvedThinkingLevel?.trim()
  return {
    id,
    label: description?.trim() || id,
    // A cancelled run can report zero; keep the running totals.
    ...(tokens ? { tokens } : {}),
    ...(cost ? { cost } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {})
  }
}

function progressUpdate(value: unknown): AcpSubagentUpdate[] {
  const progress = progressSchema.safeParse(value)
  if (!progress.success) {
    return []
  }
  const state = PROGRESS_STATES.get(progress.data.status)
  return state ? [{ ...described(progress.data, progress.data.cost), state }] : []
}

function resultUpdate(value: unknown): AcpSubagentUpdate[] {
  const result = resultSchema.safeParse(value)
  if (!result.success) {
    return []
  }
  const { exitCode, output, error, aborted, usage } = result.data
  const update = described(result.data, usage?.cost.total)
  if (aborted) {
    return [{ ...update, state: 'stopped' }]
  }
  const reply = output?.trim()
  if (error || exitCode !== 0) {
    const detail = error?.trim() || reply
    return [{ ...update, state: 'failed', ...(detail ? { error: detail } : {}) }]
  }
  // The task call's own output already shows the reply, so it stays off the timeline.
  return [{ ...update, state: 'completed', ...(reply ? { reply } : {}) }]
}

export function ompToolSubagents(update: ToolCallUpdate): AcpSubagentUpdate[] {
  const details = taskOutputSchema.safeParse(update.rawOutput).data?.details
  if (!details) {
    return []
  }
  // A returned blocking call lists every subagent in `results`; `progress` is then absent.
  return details.results?.length
    ? details.results.flatMap(resultUpdate)
    : (details.progress ?? []).flatMap(progressUpdate)
}
