import { z } from 'zod'
import type { AgentJournalToolCallItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import type { AcpSubagentUpdate } from './acp-dialect'

const taskInputSchema = z.looseObject({
  description: z.string().optional(),
  subagent_type: z.string().optional()
})
const taskOutputSchema = z.looseObject({ text: z.string() })

function taskOutput(update: ToolCallUpdate): string | undefined {
  return taskOutputSchema.safeParse(update.rawOutput).data?.text.trim() || undefined
}

/** Droid's Task call is its subagent; the call id is the only id every update carries (1.17.2). */
export function droidToolSubagents(
  update: ToolCallUpdate,
  tool: AgentJournalToolCallItem
): AcpSubagentUpdate[] {
  if (tool.name !== 'Task') {
    return []
  }
  const id = update.toolCallId
  const output = taskOutput(update)
  if (update.status === 'failed') {
    // A Task refused before it started never ran a subagent.
    return [{ id, state: 'failed', knownOnly: true, ...(output ? { error: output } : {}) }]
  }
  if (update.status === 'completed') {
    // A backgrounded Task also closes with an empty completed while its subagent still runs.
    return output ? [{ id, state: 'completed', reply: output }] : []
  }
  // Pending may still wait for approval; the subagent starts with Droid's next update.
  if (update.status === 'pending') {
    return []
  }
  const input = taskInputSchema.safeParse(update.rawInput ?? tool.input).data
  const label = input?.description?.trim() || input?.subagent_type?.trim()
  return [{ id, state: 'working', ...(label ? { label } : {}) }]
}
