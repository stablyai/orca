import { RestartAgentParams } from '../../../../../../shared/rpc-contract/structured-agent-session/restart-agent-params'
import { defineMethod } from '../../../core'
import { requireInstalledStructuredHost } from '../creation/structured-agent-session-gate'

// The idle stop's own checks decide: a chat with any open work keeps its agent and answers `busy`.
export const STRUCTURED_AGENT_SESSION_RESTART_AGENT_METHODS = [
  defineMethod({
    name: 'agentSession.restartAgent',
    permission: 'workspace',
    params: RestartAgentParams,
    handler: async (params, ctx) => {
      const host = await requireInstalledStructuredHost(ctx, params.sessionId)
      return { outcome: await host.releaseIdleSession(params.sessionId, true) }
    }
  })
]
