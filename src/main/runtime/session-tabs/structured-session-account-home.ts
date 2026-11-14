import type { StructuredAgentId } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import { structuredAgentRuntimeMetadata } from '../agent-session/installation/structured-agent-runtime-metadata'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import { resolveHostStructuredAgentLaunchEnvironment } from '../agent-session/launch/structured-agent-launch-support'
import { agentWorkspaceTrustDecisionForWorkspace } from '../../agent-launch/trust/agent-workspace-trust-spawn'
import { OrcaRuntimeWithStructuredSessionCliWriterHost } from './structured-session-cli-writer-host'
import type { AgentSessionAccountHome } from '../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'

export abstract class OrcaRuntimeWithStructuredSessionAccountHome extends OrcaRuntimeWithStructuredSessionCliWriterHost {
  /** Resolve account home through this host's agent registration; null means unregistered and create refuses. */
  protected structuredAgentAccountHomeResolver(
    agent: StructuredAgentId,
    worktree: string,
    purpose: 'launch' | 'read' | 'identity',
    hostLaunchDirectory?: string
  ) {
    const registration = structuredAgentRuntimeMetadata(agent)
    if (!registration) {
      return null
    }
    return async ({ launchEnv, location }, permissionMode?: string) =>
      registration.resolveAccountHome(
        {
          launchEnv,
          location: location ?? null,
          purpose,
          ...(permissionMode ? { permissionMode } : {}),
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
          workspaceTrustRepoDecision: (launchLocation) =>
            launchLocation?.workspaceKind === 'folder'
              ? undefined
              : agentWorkspaceTrustDecisionForWorkspace(
                  launchLocation?.workspaceId,
                  this.requireStore()
                ),
          // The chat host's own state root (ensureStructuredAgentSessionHost).
          stateDirectory: getProfileUserDataPath(),
          hostLaunchEnvironment: (agent) =>
            resolveHostStructuredAgentLaunchEnvironment(agent, this.requireStore().getSettings()),
          hostSettings: () => this.requireStore().getSettings()
        }
      )
  }

  /** The account home a start of this chat would launch under now, read without side effects; null
   *  for an agent whose chats keep the account they were created on. `identity` names it before its
   *  folder exists; the default read checks availability. */
  async resolveStructuredAgentLaunchAccountHome(
    record: AgentSessionRecord,
    purpose: 'read' | 'identity' = 'read'
  ): Promise<AgentSessionAccountHome | null> {
    const { provider, location } = record
    if (!structuredAgentRuntimeMetadata(provider)?.launchFollowsSelection?.()) {
      return null
    }
    const read = this.structuredAgentAccountHomeResolver(provider, '', purpose)
    const launchEnv = this.structuredAgentLaunchEnv(provider, this.requireStore().getSettings())
    return (await read?.({ launchEnv, location })) ?? null
  }

  /** The same account, prepared for a start in `launchDirectory` as a create prepares it. */
  async prepareStructuredAgentLaunchAccountHome(
    record: AgentSessionRecord,
    launchDirectory: string
  ): Promise<AgentSessionAccountHome | null> {
    const { provider, location } = record
    if (!structuredAgentRuntimeMetadata(provider)?.launchFollowsSelection?.()) {
      return null
    }
    const prepare = this.structuredAgentAccountHomeResolver(provider, '', 'launch', launchDirectory)
    await this.accounts.prepareHostAgentLaunch(provider)
    const launchEnv = this.structuredAgentLaunchEnv(provider, this.requireStore().getSettings())
    return (await prepare?.({ launchEnv, location })) ?? null
  }
}
