import { OrcaRuntimeWithCrossMachineRecovery } from './orca-runtime-cross-machine-recovery'
import {
  createCrossMachineRecoveryHost,
  type CrossMachineRecoveryHost
} from './cross-machine-recovery/recovery-runtime-host'
import { createRecoveryResumeHolds } from './cross-machine-recovery/recovery-resume-holds'
import { createClaudeHelpFlagProbe } from './cross-machine-recovery/claude-help-flag-probe'
import { CLAUDE_APPEND_SYSTEM_PROMPT_FLAG } from './cross-machine-recovery/recovery-resume'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { runWorktreeChangeInvalidators } from '../ipc/worktree-change-invalidators'

export class OrcaRuntimeWithCrossMachineRecoveryHost extends OrcaRuntimeWithCrossMachineRecovery {
  private readonly crossMachineRecoveryResumeHolds = createRecoveryResumeHolds()
  private readonly claudeAppendSystemPromptProbe = createClaudeHelpFlagProbe(
    CLAUDE_APPEND_SYSTEM_PROMPT_FLAG,
    () => this.requireStore().getSettings().agentCmdOverrides
  )

  // Why: addRepo is installed on the final runtime prototype, so callers holding that type supply it.
  getCrossMachineRecoveryHost(
    addRepo: CrossMachineRecoveryHost['addRepo']
  ): CrossMachineRecoveryHost {
    return createCrossMachineRecoveryHost({
      store: this.store,
      getAuthoritativeWindow: () => this.getAvailableAuthoritativeWindow(),
      getAgentStatusSnapshot: () => this.getAgentStatusSnapshotFn?.() ?? [],
      listLocalRepos: () =>
        this.listRepos().filter((repo) => getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID),
      addRepo,
      // Why: the renderer confirms the destination through worktrees:list, whose detected-scan
      // cache only the shared invalidators clear; they include this runtime's own catalog.
      invalidateWorktreeCatalog: runWorktreeChangeInvalidators,
      resolveWorktree: (selector) => this.resolveWorktreeSelector(selector),
      ensureAgentSession: (request) => this.ensureAgentSession(request),
      resumeHolds: this.crossMachineRecoveryResumeHolds,
      supportsClaudeAppendSystemPrompt: this.claudeAppendSystemPromptProbe,
      activateWorktree: async (worktreeId) => {
        await this.activateManagedWorktree(`id:${worktreeId}`, { notifyClients: true })
      }
    })
  }
}
