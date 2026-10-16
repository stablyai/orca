import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { StructuredAgentId } from '../../../shared/agent-session-provider-handle'
import { OrcaRuntimeWithGetWorktreePs } from '../workspaces/workspace-process-listing'
import { structuredAgentRuntimeRegistration } from '../structured-agent-runtime-registrations'
import type { CliSourceStopHost } from '../structured-agent-cli-stop'
import type { OrcaRuntimeWithStopExactTerminalsForWorktree } from '../terminal/stop/worktree-terminal-stop-targets'
import { PTY_JOB_NOT_TERMINATED } from '../../providers/pty-job-termination-report-validation'

/** Host-side terminal facts and agent account selection for chat adoption. */
export abstract class OrcaRuntimeWithStructuredSessionCliSourceHost extends OrcaRuntimeWithGetWorktreePs {
  abstract stopExactTerminalsForWorktree(
    ...args: Parameters<OrcaRuntimeWithStopExactTerminalsForWorktree['stopExactTerminalsForWorktree']>
  ): ReturnType<OrcaRuntimeWithStopExactTerminalsForWorktree['stopExactTerminalsForWorktree']>

  cliSourceStopHost(): CliSourceStopHost {
    return {
      rows: () => this.getAgentProviderSessionRows(),
      resolvePane: (paneKey, workspaceId) => this.resolveTerminalPane(paneKey, workspaceId),
      sleeping: (workspaceId) => [...this.terminalSleepStateByWorktreeId.values()].some(
        (state) => state.worktreeId === workspaceId &&
          (state.phase === 'sleeping' || state.phase === 'partial')
      ),
      presence: (paneKey) => this.checkHookAgentPresenceFn?.(paneKey) ?? Promise.resolve(null),
      shellForeground: (ptyId) => this.ptyController?.confirmShellForeground?.(ptyId) ?? Promise.resolve(false),
      rootPid: async (ptyId) => {
        const processes = await this.ptyController?.listProcesses?.(LOCAL_EXECUTION_HOST_ID)
        return processes?.find((entry) => entry.id === ptyId)?.rootProcessId ?? null
      },
      stop: (workspaceId, ptyId) => this.stopExactTerminalsForWorktree(
        `id:${workspaceId}`, [ptyId], { targetOnly: true, keepHistory: false }
      ),
      terminateJobAndReport: (ptyId) =>
        this.ptyController?.terminatePtyJobAndReport?.(ptyId) ??
        Promise.resolve(PTY_JOB_NOT_TERMINATED)
    }
  }

  /** An adopted chat launches under the account home that owns the source transcript. */
  protected structuredAgentAccountHomeResolver(
    agent: StructuredAgentId,
    worktree: string,
    purpose: 'launch' | 'read',
    hostLaunchDirectory?: string
  ) {
    const registration = structuredAgentRuntimeRegistration(agent)
    if (!registration) {
      return null
    }
    const services = {
      getClaudeConfigDirectory: (target) => this.accounts.getClaudeConfigDirectory(target),
      prepareCodexLaunchHome: this.prepareCodexStructuredLaunchFn,
      readCodexLaunchHome: this.resolveCodexStructuredLaunchHomeFn,
      workspaceTrustSettings: () => this.requireStore().getSettings()
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
        services
      )
  }
}
