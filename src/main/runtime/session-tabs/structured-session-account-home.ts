import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { bindGitHubParticipantSession } from '../github-participant-job-binding'
import type { StructuredAgentId } from '../../../shared/agent-session-provider-handle'
import { structuredAgentRuntimeMetadata } from '../structured-agent-runtime-metadata'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import { OrcaRuntimeWithStructuredSessionCliWriterHost } from './structured-session-cli-writer-host'

export abstract class OrcaRuntimeWithStructuredSessionAccountHome extends OrcaRuntimeWithStructuredSessionCliWriterHost {
  async bindStructuredSessionGitHubParticipant(worktree: string, sessionId: string): Promise<void> {
    if (!this.getGitHubParticipantRegistry()?.hasEnabledRepos()) {
      return
    }
    const target = await this.resolveRuntimeFileTarget(worktree)
    bindGitHubParticipantSession(
      this.requireStore(),
      target.worktree.repoId,
      target.worktree.id,
      sessionId,
      getStructuredAgentSessionHost()?.deps.store.getRecord(sessionId) != null
    )
  }

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
}
