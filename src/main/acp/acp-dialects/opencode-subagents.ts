// OpenCode relays a subagent's work on the parent session, tagged with its child session (2.x recordings).

import { z } from 'zod'
import type { AgentJournalToolCallItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { SessionUpdate, ToolCallUpdate } from '../generated/acp-protocol.generated'
import type { AcpChildSession, AcpSubagentUpdate } from './acp-dialect'

const idSchema = z.string().trim().min(1)
const childSessionMetaSchema = z.looseObject({
  'opencode/child-session': z.looseObject({
    id: idSchema,
    parentID: idSchema.optional().catch(undefined),
    title: z.string().optional().catch(undefined)
  })
})
const spawnOutputSchema = z.looseObject({
  // 2.x writes sessionID; 1.x wrote sessionId.
  metadata: z.looseObject({
    sessionID: idSchema.optional().catch(undefined),
    sessionId: idSchema.optional().catch(undefined)
  }),
  error: z.string().optional().catch(undefined)
})
const spawnInputSchema = z.looseObject({ description: z.string().optional().catch(undefined) })
// 1.x calls its spawn tool `task`; 2.x renamed it `subagent`.
const SPAWN_TOOLS: ReadonlySet<string> = new Set(['task', 'subagent'])
const STOPPED_ERROR = /interrupted|cancel/i

export function openCodeChildSession(update: SessionUpdate): AcpChildSession | undefined {
  const parsed = childSessionMetaSchema.safeParse('_meta' in update ? update._meta : undefined)
  if (!parsed.success) {
    return undefined
  }
  const { id, parentID, title } = parsed.data['opencode/child-session']
  const label = title?.trim()
  return { id, ...(parentID ? { parentId: parentID } : {}), ...(label ? { label } : {}) }
}

/** The spawn call settles with its child session's ID; Stop reports an interrupted call. */
export function openCodeToolSubagents(
  update: ToolCallUpdate,
  tool: AgentJournalToolCallItem
): AcpSubagentUpdate[] {
  if (!SPAWN_TOOLS.has(tool.name) || (tool.state !== 'completed' && tool.state !== 'failed')) {
    return []
  }
  const output = spawnOutputSchema.safeParse(update.rawOutput)
  const id = output.success
    ? (output.data.metadata.sessionID ?? output.data.metadata.sessionId)
    : undefined
  if (!id) {
    return []
  }
  const label = spawnInputSchema.safeParse(tool.input).data?.description?.trim()
  return [
    {
      id,
      state:
        tool.state === 'completed'
          ? 'completed'
          : STOPPED_ERROR.test(output.data?.error ?? '')
            ? 'stopped'
            : 'failed',
      ...(label ? { label } : {})
    }
  ]
}
