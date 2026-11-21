import { defineMethod } from '../../../core'
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
  closeAuxiliaryChatChildren,
  retireCapturedStructuredSessionSurface
} from '../../../../agent-session/lifecycle/structured-agent-session-close'
import { discardAuxiliaryChatFile } from '../../../../agent-session/lifecycle/structured-agent-session-auxiliary-file'
import { structuredSessionCloseSettled } from '../../../../orchestration/terminal-authority/structured-sessions/structured-worker-authority'

export const STRUCTURED_AGENT_SESSION_CLOSE_METHOD = defineMethod({
  // Close only provider/in-memory state, preserving record/journal for future attachment.
  name: 'agentSession.close',
  permission: 'workspace',
  params: OptionsParams,
  handler: async (params, ctx) => {
    requireStructuredCapability(ctx)
    // An unlisted auxiliary child must stop when its side chat closes, even in a bot home.
    const auxiliary =
      getStructuredAgentSessionHost()?.deps.store.getRecord(params.sessionId)?.auxiliaryChat !==
      undefined
    // A bot's thread or run keeps working when its tab closes; it waits in the bot's Activity.
    const keepRunning = !auxiliary && runsForBot(ctx.runtime.bots, params.sessionId)
    // Record close before requiring host so even failed closes fence racing creates.
    if (ORCA_LAYOUT_OWNER_IS_MAIN && !keepRunning) {
      noteStructuredAgentSessionClose(
        params.sessionId,
        (getStructuredAgentSessionHost()?.deps.store.getConversation(params.sessionId) ?? null) !==
          null
      )
    }
    const host = requireStructuredCleanupHost(ctx)
    const record = host.deps.store.getRecord(params.sessionId)
    // A visible parent owns its hidden children; close them first so a parent failure leaves no orphan.
    if (!keepRunning && record && !record.auxiliaryChat) {
      await closeAuxiliaryChatChildren(host, params.sessionId, ctx.runtime)
    }
    const surface = captureStructuredSessionSurface(host, params.sessionId, ctx.runtime)
    let surfaceFailure: unknown
    try {
      const result = await retireCapturedStructuredSessionSurface(
        host,
        params.sessionId,
        surface,
        ctx.runtime,
        keepRunning
      )
      surfaceFailure = result.error
    } catch (error) {
      surfaceFailure = error
    }
    if (!keepRunning) {
      await host.close(params.sessionId, 'user-close')
    }
    // A derived file is removed only after its own child exit is proven.
    if (record?.auxiliaryChat && structuredSessionCloseSettled(params.sessionId)) {
      await discardAuxiliaryChatFile(record.auxiliaryChat).catch((error: unknown) =>
        console.warn('[structured-agent-session] discarding an auxiliary chat file failed', error)
      )
    }
    if (surfaceFailure !== undefined) {
      throw surfaceFailure
    }
    return { ok: true as const }
  }
})
