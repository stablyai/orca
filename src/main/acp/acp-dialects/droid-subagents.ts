// Droid 1.17.2 reports a Task subagent only on its own call, keyed by the call id.

import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import type { AgentJournalToolCallItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import type { AcpSubagentUpdate } from './acp-dialect'

const taskInputSchema = lazyZodSchema(() =>
  z.looseObject({
    description: z.string().optional(),
    subagent_type: z.string().optional()
  })
)
const taskOutputSchema = lazyZodSchema(() => z.looseObject({ text: z.string() }))
const childLinkSchema = lazyZodSchema(() =>
  z.looseObject({ subagent_session_info: z.looseObject({}) })
)
// The results Droid writes for a call that a Stop or its own shutdown cut off.
const INTERRUPTED = /^Tool execution (?:cancelled by user|was interrupted)$/

export function droidToolSubagents(
  update: ToolCallUpdate,
  tool: AgentJournalToolCallItem
): AcpSubagentUpdate[] {
  if (tool.name !== 'Task') {
    return []
  }
  const id = update.toolCallId
  const output = taskOutputSchema.safeParse(update.rawOutput).data?.text.trim()
  if (update.status === 'failed') {
    if (output && INTERRUPTED.test(output)) {
      return [{ id, state: 'stopped', knownOnly: true }]
    }
    // A Task refused before it started never ran a subagent.
    return [{ id, state: 'failed', knownOnly: true, ...(output ? { error: output } : {}) }]
  }
  if (update.status === 'completed') {
    // At a turn's end Droid closes a backgrounded Task with no result while its subagent may still
    // run; the result comes on a later update.
    if (output === undefined) {
      return []
    }
    return [{ id, state: 'completed', ...(output ? { reply: output } : {}) }]
  }
  // A pending Task may still wait for approval; a linked child session proves it started.
  if (update.status === 'pending' && !childLinkSchema.safeParse(update._meta).success) {
    return []
  }
  const input = taskInputSchema.safeParse(tool.input).data
  const label = input?.description?.trim() || input?.subagent_type?.trim()
  return [{ id, state: 'working', ...(label ? { label } : {}) }]
}
