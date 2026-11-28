import {
  agentSessionMcpFailureMessage,
  type AgentSessionMcpResult
} from '../../../../../../shared/agent-session/options/protocol/agent-session-mcp'
import { agentSessionAccountHomePath } from '../../../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { defineMethod } from '../../../core'
import {
  refuseRemovedOrcaReconnect,
  withOrcaMcpChanges,
  withOrcaMcpSource
} from '../../../../../mcp-servers/session-host-mcp-delivery'
import { withKnownSessionMcpServers } from '../../../../../mcp-servers/session-mcp-at-rest'
import { isMcpServersFeatureEnabled } from '../../../../../mcp-servers/mcp-servers-feature'
import { agentSessionPinnedLaunchDirectory } from '../../../../agent-session/records/agent-session-record-launch-directory'
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
      // With MCP servers on, Orca lists what it knows of a chat's servers where its agent can't; a
      // bot's chat gets its own tools too, which only its launch reads.
      const knows =
        isMcpServersFeatureEnabled() &&
        saved != null &&
        host.deps.isBotHome?.(saved.location.workspaceId) !== true
      if (!saved || (!manage && !knows)) {
        return { status: 'unsupported' }
      }
      // Read before the agent answers: one that starts meanwhile lists Orca's servers itself.
      const running = host.agentRunning(sessionId)
      // An agent at rest is managed on the account its next turn launches on, as /usage reads it.
      const accountHome = await host.deps.launchAccountHome?.(saved).catch(() => null)
      const record = accountHome ? { ...saved, accountHome } : saved
      // Only a running chat keeps servers Orca changed since its launch (a bot's too, when it takes
      // the host's list); one at rest reads the list.
      const changes =
        running && isMcpServersFeatureEnabled()
          ? ((await host.deps.launchTools?.hostChanges?.(sessionId).catch(() => null)) ?? undefined)
          : undefined
      const refused =
        operation.action === 'reconnect' && changes
          ? refuseRemovedOrcaReconnect(sessionId, operation.server, changes)
          : null
      const answer: AgentSessionMcpResult = refused
        ? refused
        : manage
          ? await manage(record, operation).then(
              (result) => withOrcaMcpSource(sessionId, result),
              (error: unknown) => ({
                status: 'failed',
                message: agentSessionMcpFailureMessage(error)
              })
            )
          : { status: 'unsupported' }
      if (!knows) {
        return withOrcaMcpChanges(answer, changes)
      }
      const known = await withKnownSessionMcpServers(answer, {
        sessionId,
        agent: saved.provider,
        workspaceId: saved.location.workspaceId,
        cwd: async () =>
          agentSessionPinnedLaunchDirectory(saved) ??
          (await host.deps.resolveWorkspacePath?.(saved.location.workspaceId).catch(() => null)) ??
          null,
        accountHome: agentSessionAccountHomePath(record.accountHome),
        running,
        manages: manage !== undefined
      })
      return withOrcaMcpChanges(known, changes)
    }
  })
]
