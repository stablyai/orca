import { z } from 'zod'
import type { AcpAgentError } from '../transport/acp-errors'
import type { AcpDialect, AcpDialectNotification } from './acp-dialect'

const errorKindSchema = z.looseObject({ 'cognition.ai/errorKind': z.string() })
const promptResultMetaSchema = z.looseObject({ 'cognition.ai/userMessageId': z.string().min(1) })
const displayEchoSchema = z.looseObject({
  update: z.looseObject({
    sessionUpdate: z.literal('agent_message_chunk'),
    content: z.looseObject({ type: z.literal('text'), text: z.literal('Context compacted') }),
    _meta: z.looseObject({ 'cognition.ai/displayMessage': z.literal(true) })
  })
})
const updateMetaSchema = z.looseObject({
  update: z.looseObject({
    _meta: z
      .looseObject({
        'cognition.ai/subagent_started': z
          .looseObject({ agentId: z.string().min(1), title: z.string().optional() })
          .optional(),
        'cognition.ai/subagent_completed': z
          .looseObject({
            agentId: z.string().min(1),
            success: z.boolean().optional(),
            summary: z.string().optional()
          })
          .optional()
      })
      .optional()
  })
})

// Devin's session errors are also its ACP codes, for releases without errorKind metadata.
const SESSION_NOT_FOUND = -32016
const SESSION_LOCKED = -32015

function errorKind(error: AcpAgentError): string | undefined {
  return errorKindSchema.safeParse(error.data).data?.['cognition.ai/errorKind']
}

// Compaction reports are not turn events; the display-only echo is not agent text. Child-agent
// progress arrives as tool_call_update frames for a call that never opened — map them to the
// subagent roster so no orphan tool row appears.
function notification(method: string, params: unknown): AcpDialectNotification | undefined {
  const started =
    updateMetaSchema.safeParse(params).data?.update._meta?.['cognition.ai/subagent_started']
  if (started) {
    return {
      disposition: 'map',
      consumed: true,
      subagents: [
        {
          id: started.agentId,
          state: 'working',
          ...(started.title ? { label: started.title } : {})
        }
      ]
    }
  }
  const completed =
    updateMetaSchema.safeParse(params).data?.update._meta?.['cognition.ai/subagent_completed']
  if (completed) {
    return {
      disposition: 'map',
      consumed: true,
      subagents: [
        {
          id: completed.agentId,
          state: completed.success === false ? 'failed' : 'completed',
          ...(completed.summary ? { result: completed.summary } : {})
        }
      ]
    }
  }
  if (
    method === '_cognition.ai/compaction' ||
    (method === 'session/update' && displayEchoSchema.safeParse(params).success)
  ) {
    return { disposition: 'ignore' }
  }
  return undefined
}

// No authenticationRequired: signed-out prompts already arrive as -32000.
export const DEVIN_ACP_DIALECT: AcpDialect = {
  notification,
  // -32016, not -32002, also for a session never saved (Devin saves on the first prompt).
  sessionLost: (error) =>
    errorKind(error) === 'session_not_found' || error.code === SESSION_NOT_FOUND,
  sessionInUse: (error) => errorKind(error) === 'session_locked' || error.code === SESSION_LOCKED,
  // The result names the provider's turn, which its session/load replay repeats.
  promptTurnId: (meta) =>
    promptResultMetaSchema.safeParse(meta).data?.['cognition.ai/userMessageId'],
  // Account, mode and model commands bypass the chat's sign-in and pickers; /compact and
  // /goal keep Devin working after their reply, and /rename, /share and /handoff mutate or
  // move the session outside Orca.
  withheldCommands: [
    'login',
    'logout',
    'billing',
    'ask',
    'plan',
    'code',
    'smart',
    'bypass',
    'fast',
    'compact',
    'goal',
    'rename',
    'share',
    'handoff'
  ]
}
