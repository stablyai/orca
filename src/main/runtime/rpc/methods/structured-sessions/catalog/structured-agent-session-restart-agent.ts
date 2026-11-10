import { RestartAgentParams } from '../../../../../../shared/agent-session/agent-session-restart-agent'
import { defineMethod } from '../../../core'
import { requireInstalledStructuredHost } from '../creation/structured-agent-session-gate'

export const STRUCTURED_AGENT_SESSION_RESTART_AGENT_METHODS = [
  defineMethod({
    // The next send starts the agent again; nothing is sent here.
    name: 'agentSession.restartAgent',
    permission: 'workspace',
    params: RestartAgentParams,
    handler: async (params, ctx) => {
      const host = await requireInstalledStructuredHost(ctx, params.sessionId)
      return host.restartAgent(params.sessionId, params.force === true)
    }
  })
]
