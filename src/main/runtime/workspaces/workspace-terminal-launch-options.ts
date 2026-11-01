import { sequenceInitialTerminalCommand } from '../runtime-worktree-initial-surface'
import { applyRemoteViewerLaunchEnv } from '../remote-viewer-launch-env'
import type { TerminalWorkspaceLaunchScope } from '../runtime-legacy-worker-terminal-recovery-types'
import type { TerminalCreateOptions } from '../runtime-terminal-contracts'
import {
  resolveAgentTerminalCreateOptions,
  withHostAccountLaunchEnv
} from '../runtime-agent-terminal-startup'
import { OrcaRuntimeWithRemoveManagedWorktree } from './workspace-removal'

export abstract class OrcaRuntimeWithTerminalLaunchOptions extends OrcaRuntimeWithRemoveManagedWorktree {
  async resolveAgentTerminalCreateOptions(
    workspace: TerminalWorkspaceLaunchScope,
    opts: TerminalCreateOptions
  ): Promise<TerminalCreateOptions> {
    const resolvedLaunch = await resolveAgentTerminalCreateOptions(workspace, opts, {
      store: this.store,
      hostIdentity: this.runtimeId,
      toSessionOptions: (preferences) => this.toAgentSessionOptions(preferences)
    })
    const launch = sequenceInitialTerminalCommand(
      applyRemoteViewerLaunchEnv(resolvedLaunch, opts.terminalImageViewerSupported),
      opts.sequenceTerminalCommand
    )
    // An SSH workspace's shell runs on that machine, where this distro's account paths mean nothing.
    if (workspace.connectionId) {
      return launch
    }
    if (launch.launchAgent) {
      await this.accounts.prepareHostAgentLaunch(launch.launchAgent)
    }
    const hostLaunchEnv = this.accounts.hostLaunchEnvFor(launch.launchAgent)
    return withHostAccountLaunchEnv(opts, launch, hostLaunchEnv)
  }
}
