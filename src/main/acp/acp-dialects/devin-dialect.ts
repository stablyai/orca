import { z } from 'zod'
import type { AcpAgentError } from '../acp-errors'
import type { AcpDialect, AcpDialectNotification } from './acp-dialect'

const errorKindSchema = z.looseObject({ 'cognition.ai/errorKind': z.string() })
const displayEchoSchema = z.looseObject({
  update: z.looseObject({
    sessionUpdate: z.literal('agent_message_chunk'),
    content: z.looseObject({ type: z.literal('text'), text: z.literal('Context compacted') }),
    _meta: z.looseObject({ 'cognition.ai/displayMessage': z.literal(true) })
  })
})

function errorKind(error: AcpAgentError): string | undefined {
  return errorKindSchema.safeParse(error.data).data?.['cognition.ai/errorKind']
}

// Compaction reports are not turn events; the display-only echo is not agent text.
function notification(method: string, params: unknown): AcpDialectNotification | undefined {
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
  sessionLost: (error) => errorKind(error) === 'session_not_found',
  sessionInUse: (error) => errorKind(error) === 'session_locked',
  // Account and mode commands bypass the chat's sign-in and permission picker;
  // /compact replies before compacting, so the chat would look idle while Devin works.
  withheldCommands: [
    'login',
    'logout',
    'billing',
    'ask',
    'plan',
    'code',
    'smart',
    'bypass',
    'compact'
  ]
}
