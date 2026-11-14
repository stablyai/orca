import {
  agentSessionMcpFailureMessage,
  type AgentSessionMcpResult
} from '../../../../../../shared/agent-session/agent-session-mcp'
import { defineMethod } from '../../../core'
import { requireInstalledStructuredHost } from '../creation/structured-agent-session-gate'
import { AgentSessionMcpParams } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-mcp-params'

export const STRUCTURED_AGENT_SESSION_MCP_METHODS = [
  defineMethod({
    name: 'agentSession.mcp',
    permission: 'workspace',
    params: AgentSessionMcpParams,
    // MCP management talks to the running agent directly, outside the conversation's mutation queue.
    handler: async ({ sessionId, operation }, ctx): Promise<AgentSessionMcpResult> => {
      const host = await requireInstalledStructuredHost(ctx, sessionId)
      const saved = host.deps.store.getRecord(sessionId)
      const manage = saved && host.deps.agents.registration(saved.provider)?.adapter.manageMcp
      if (!saved || !manage) {
        return { status: 'unsupported' }
      }
      // An agent at rest is managed on the account its next turn launches on, as /usage reads it.
      const accountHome = await host.deps.launchAccountHome?.(saved).catch(() => null)
      const record = accountHome ? { ...saved, accountHome } : saved
      try {
        return await manage(record, operation)
      } catch (error) {
        return { status: 'failed', message: agentSessionMcpFailureMessage(error) }
      }
    }
  })
]
