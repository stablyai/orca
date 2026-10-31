import type { StructuredAgentId } from '../../../shared/agent-session-provider-handle'
import { isStructuredAgentId } from '../../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import { createStructuredAgentAccountFollow } from '../structured-agent-account-follow'
import type { StructuredAgentSessionAccountFollow } from '../../native-chat/agent-session-wire/structured-agent-session-account-follow'
import { structuredAgentRuntimeMetadata } from '../structured-agent-runtime-metadata'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import { OrcaRuntimeWithStructuredSessionCliWriterHost } from './structured-session-cli-writer-host'

export abstract class OrcaRuntimeWithStructuredSessionAccountHome extends OrcaRuntimeWithStructuredSessionCliWriterHost {
  /** Resolve account home through this host's agent registration; null means unregistered and create refuses. */
  protected structuredAgentAccountHomeResolver(
    agent: StructuredAgentId,
    worktree: string,
    purpose: 'launch' | 'read',
    hostLaunchDirectory?: string
  ) {
    const registration = structuredAgentRuntimeMetadata(agent)
    if (!registration) {
      return null
    }
    return async ({ launchEnv, location }) =>
      registration.resolveAccountHome(
        {
          launchEnv,
          location: location ?? null,
          purpose,
          workspacePath:
            purpose === 'launch'
              ? async () =>
                  hostLaunchDirectory ??
                  (await this.resolveRuntimeFileTarget(worktree)).worktree.path
              : null
        },
        {
          getClaudeConfigDirectory: (target) => this.accounts.getClaudeConfigDirectory(target),
          prepareCodexLaunchHome: this.prepareCodexStructuredLaunchFn,
          readCodexLaunchHome: this.resolveCodexStructuredLaunchHomeFn,
          workspaceTrustSettings: () => this.requireStore().getSettings(),
          // The chat host's own state root (ensureStructuredAgentSessionHost).
          stateDirectory: getProfileUserDataPath()
        }
      )
  }

  /** Chats on this host follow its account picker. */
  protected structuredChatAccountFollow(): StructuredAgentSessionAccountFollow {
    return createStructuredAgentAccountFollow({
      ownsAccounts: () => this.accounts.ownsAccountServices(),
      resolveSelectedHome: (record, purpose) =>
        this.resolveStructuredChatSelectedAccountHome(record, purpose),
      getSettings: () => this.requireStore().getSettings()
    })
  }

  /** The home a chat would pin if created now: a launch also prepares it, as create does. */
  private async resolveStructuredChatSelectedAccountHome(
    record: AgentSessionRecord,
    purpose: 'launch' | 'read'
  ): Promise<AgentSessionAccountHome> {
    const agent = record.provider
    const resolveAccountHome = isStructuredAgentId(agent)
      ? this.structuredAgentAccountHomeResolver(
          agent,
          `id:${record.location.workspaceId}`,
          purpose,
          record.launchDirectory
        )
      : null
    if (!isStructuredAgentId(agent) || !resolveAccountHome) {
      throw agentSessionRefusalError('structured_agent_session_unsupported', {
        reason: 'hostUnsupported'
      })
    }
    await this.accounts.prepareHostAgentLaunch(purpose === 'launch' ? agent : null)
    const launchEnv = this.structuredAgentLaunchEnv(agent, this.requireStore().getSettings())
    return resolveAccountHome({ launchEnv, location: record.location })
  }
}
