import { defineMethod } from '../../../core'
import { requireInstalledStructuredHost } from '../creation/structured-agent-session-gate'
import { AgentSessionMcpParams } from '../../../../../../shared/rpc-contract/agent-session-mcp-params'
import type { AgentSessionMcpResult } from '../../../../../../shared/agent-session/agent-session-mcp'

export const STRUCTURED_AGENT_SESSION_MCP_METHODS = [
  defineMethod({
    name: 'agentSession.mcp',
    permission: 'workspace',
    params: AgentSessionMcpParams,
    handler: async ({ sessionId, operation }, ctx): Promise<AgentSessionMcpResult> => {
      const host = await requireInstalledStructuredHost(ctx, sessionId)
      const record = host.deps.store.getRecord(sessionId)
      const adapter = record && host.deps.agents.registration(record.provider)?.adapter
      return adapter?.manageMcp
        ? adapter.manageMcp(sessionId, operation)
        : { status: 'unavailable' }
    }
  })
]
