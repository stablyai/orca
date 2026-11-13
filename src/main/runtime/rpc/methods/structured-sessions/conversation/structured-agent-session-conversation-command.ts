import type { z } from 'zod'
import type { ConversationCommandParams } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'
import { recordMobileChatSend } from '../../../../../telemetry/mobile-client-telemetry'
import type { RpcContext } from '../../../core'
import {
  ensureStructuredHostInstalled,
  requireStructuredCapability,
  requireStructuredSessionHost,
  structuredCallerFor
} from '../creation/structured-agent-session-gate'

/** A person's slash command runs as their send; the desktop composer counts it as one too. */
export async function runConversationCommandForClient(
  params: z.infer<typeof ConversationCommandParams>,
  ctx: RpcContext
) {
  requireStructuredCapability(ctx)
  await ensureStructuredHostInstalled(ctx)
  const host = requireStructuredSessionHost(ctx, params.envelope.sessionId)
  await host.revealSession(params.envelope.sessionId)
  const result = await host.conversationCommand(structuredCallerFor(ctx), {
    ...params,
    userSend: true
  })
  recordMobileChatSend(ctx.clientKind, host.sessionAgent(params.envelope.sessionId), result)
  return result
}
