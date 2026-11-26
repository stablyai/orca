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
import type { StructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { noteStructuredAgentSessionClose } from '../creation/structured-agent-session-close-before-create'
import {
  captureStructuredSessionSurface,
  retireCapturedStructuredSessionSurface
} from '../../../../agent-session/lifecycle/structured-agent-session-close'

export const STRUCTURED_AGENT_SESSION_CLOSE_METHOD = defineMethod({
  // Close only provider/in-memory state, preserving record/journal for future attachment.
  name: 'agentSession.close',
  permission: 'workspace',
  params: OptionsParams,
  handler: async (params, ctx) => {
    requireStructuredCapability(ctx)
    await closeStructuredAgentSessionForUser(ctx.runtime, params.sessionId, () =>
      requireStructuredCleanupHost(ctx)
    )
    return { ok: true as const }
  }
})

/** What closing a chat tab does; `requireHost` runs after the close is recorded. */
export async function closeStructuredAgentSessionForUser(
  runtime: RpcContext['runtime'],
  sessionId: string,
  requireHost: () => StructuredAgentSessionHost
): Promise<void> {
  // A bot's thread or run keeps working when its tab closes; it waits in the bot's Activity.
  const keepRunning = runsForBot(runtime.bots, sessionId)
  // Record close before requiring host so even failed closes fence racing creates.
  if (ORCA_LAYOUT_OWNER_IS_MAIN && !keepRunning) {
    noteStructuredAgentSessionClose(
      sessionId,
      (getStructuredAgentSessionHost()?.deps.store.getConversation(sessionId) ?? null) !== null
    )
  }
  const host = requireHost()
  const surface = captureStructuredSessionSurface(host, sessionId, runtime)
  try {
    const result = await retireCapturedStructuredSessionSurface(
      host,
      sessionId,
      surface,
      runtime,
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
