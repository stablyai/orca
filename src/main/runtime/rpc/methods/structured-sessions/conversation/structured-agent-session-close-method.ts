import { defineMethod, type RpcContext } from '../../../core'
import { OptionsParams } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'
import '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-continue-params'
import '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-rename-params'
import '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-queued-edit-params'
import {
  requireStructuredCapability,
  requireStructuredCleanupHost
} from '../creation/structured-agent-session-gate'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/workspace-layout/layout-owner-switch'
import { runsForBot } from '../../../../../bots/bot-session-tabs'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { noteStructuredAgentSessionClose } from '../creation/structured-agent-session-close-before-create'
import {
  captureStructuredSessionSurface,
  retireCapturedStructuredSessionSurface
} from '../../../../agent-session/lifecycle/structured-agent-session-close'

/** Closes one chat's provider/in-memory state and its tab; shared by `agentSession.close` and `agent.close`. */
export async function closeStructuredAgentSession(
  ctx: RpcContext,
  sessionId: string
): Promise<void> {
  requireStructuredCapability(ctx)
  // A bot's thread or run keeps working when its tab closes; it waits in the bot's Activity.
  const keepRunning = runsForBot(ctx.runtime.bots, sessionId)
  // Record close before requiring host so even failed closes fence racing creates.
  if (ORCA_LAYOUT_OWNER_IS_MAIN && !keepRunning) {
    noteStructuredAgentSessionClose(
      sessionId,
      (getStructuredAgentSessionHost()?.deps.store.getConversation(sessionId) ?? null) !== null
    )
  }
  const host = requireStructuredCleanupHost(ctx)
  const surface = captureStructuredSessionSurface(host, sessionId, ctx.runtime)
  try {
    const result = await retireCapturedStructuredSessionSurface(
      host,
      sessionId,
      surface,
      ctx.runtime,
      keepRunning
    )
    if (result.error !== undefined) {
      throw result.error
    }
  } finally {
    if (!keepRunning) {
      await host.close(sessionId, 'user-close')
    }
  }
}

export const STRUCTURED_AGENT_SESSION_CLOSE_METHOD = defineMethod({
  // Close only provider/in-memory state, preserving record/journal for future attachment.
  name: 'agentSession.close',
  permission: 'workspace',
  params: OptionsParams,
  handler: async (params, ctx) => {
    await closeStructuredAgentSession(ctx, params.sessionId)
    return { ok: true as const }
  }
})
