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
const progressSchema = z.looseObject({
  id: idSchema,
  status: z.string(),
  description: z.string().optional(),
  tokens: tokenCount.optional()
})
const resultSchema = z.looseObject({
  id: idSchema,
  description: z.string().optional(),
  exitCode: z.number().int(),
  output: z.string().optional(),
  error: z.string().optional(),
  aborted: z.boolean().optional(),
  tokens: tokenCount.optional()
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
  id: string,
  description: string | undefined,
  tokens: number | undefined
): AcpSubagentUpdate {
  // A cancelled run can report zero; keep the running total.
  return { id, label: description?.trim() || id, ...(tokens ? { tokens } : {}) }
}

function progressUpdate(value: unknown): AcpSubagentUpdate[] {
  const progress = progressSchema.safeParse(value)
  if (!progress.success) {
    return []
  }
  const { id, status, description, tokens } = progress.data
  const state = PROGRESS_STATES.get(status)
  return state ? [{ ...described(id, description, tokens), state }] : []
}

function resultUpdate(value: unknown): AcpSubagentUpdate[] {
  const result = resultSchema.safeParse(value)
  if (!result.success) {
    return []
  }
  const { id, description, exitCode, output, error, aborted, tokens } = result.data
  const update = described(id, description, tokens)
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
