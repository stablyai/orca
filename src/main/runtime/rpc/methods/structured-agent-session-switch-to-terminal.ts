import { executeStructuredSessionSwitch } from './structured-agent-session-switch-execution'
import type { AgentSessionSwitchResult } from '../../../../shared/agent-session-switch-execution'
import { inPlaceSwitchEnabled } from '../../../../shared/structured-agent-cli-conversation-adoption'
import type { AiVaultChatForkSource } from '../../../../shared/ai-vault-resume-preparation'
import {
  prepareStructuredChatCliTranscript,
  resolveStructuredChatCliSource
} from '../../../ai-vault/structured-chat-cli-fork'
import { defineMethod } from '../core'
import {
  ensureStructuredHostInstalled,
  requireStructuredCapability,
  requireStructuredSessionHost
} from './structured-agent-session-gate'
import { SwitchToTerminalParams } from './structured-agent-session-schemas'

// Prepare the ordinary same-id resume recipe, then join Stop and positive physical exit.

export const STRUCTURED_AGENT_SESSION_SWITCH_TO_TERMINAL_METHODS = [
  defineMethod({
    name: 'agentSession.switchToTerminal',
    permission: 'workspace',
    params: SwitchToTerminalParams,
    handler: async (
      params,
      ctx
    ): Promise<{ source: AiVaultChatForkSource } | AgentSessionSwitchResult> => {
      requireStructuredCapability(ctx)
      if (params.execution) {
        return executeStructuredSessionSwitch(params, ctx, 'terminal')
      }
      await ensureStructuredHostInstalled(ctx)
      const host = requireStructuredSessionHost(ctx, params.sessionId)
      const record = host.deps.store.getRecord(params.sessionId)
      if (!record || !inPlaceSwitchEnabled(record.provider)) {
        throw new Error('This chat cannot switch to a terminal on this host.')
      }
      // Before anything stops: the source, a route that can hold the start, and its recipe.
      const source = await resolveStructuredChatCliSource(
        { sessionId: record.sessionId, workspaceId: record.location.workspaceId },
        false
      )
      const prepared = await prepareStructuredChatCliTranscript(
        source,
        (args) => ctx.runtime.prepareAiVaultSessionResume(args),
        false
      )
      if (!prepared.cliForkSource) {
        throw new Error('This chat has no saved conversation available on this host.')
      }
      await host.switchToTerminal(params.sessionId)
      return { source: prepared.cliForkSource }
    }
  })
]
