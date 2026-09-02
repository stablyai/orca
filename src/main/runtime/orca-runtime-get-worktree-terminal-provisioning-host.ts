// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithActivateManagedWorktree } from './orca-runtime-activate-managed-worktree'
import type {
  WorktreeProvisionTerminalOptions,
  WorktreeTerminalProvisioningHost
} from './runtime-worktree-terminal-provisioning'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import type { WorktreeStartupReadinessHost } from './runtime-worktree-startup-readiness'
import { prefetchWorktreeCreateBase } from '../worktree-create-base-prefetch'
import { prepareWorktreeCreateForRepo } from '../worktree-create-preparation'
import { getWorktreeCreatePrefetchGitOptions } from '../project-runtime-git-options'

export class OrcaRuntimeWithGetWorktreeTerminalProvisioningHost extends OrcaRuntimeWithActivateManagedWorktree {
  protected getWorktreeTerminalProvisioningHost(): WorktreeTerminalProvisioningHost {
    return {
      canSpawn: () => Boolean(this.ptyController?.spawn),
      createTerminal: (selector, options) =>
        this.createTerminal(selector, options as TerminalCreateOptions),
      splitTerminal: (handle, options) =>
        this.splitTerminal(handle, options as WorktreeProvisionTerminalOptions),
      setTabColor: async (worktreeId, tabId, color) => {
        await this.setMobileSessionTabProps(`id:${worktreeId}`, { tabId, color })
      },
      getSettings: () => this.requireStore().getSettings(),
      getPtyId: (handle) => this.getLivePtyForHandle(handle)?.pty.ptyId,
      recordSetupCompletionToken: (ptyId, token) =>
        this.setupCompletionTokenByPtyId.set(ptyId, token)
    }
  }

  protected getWorktreeStartupReadinessHost(): WorktreeStartupReadinessHost {
    return {
      getPtyId: (handle) => this.getLivePtyForHandle(handle)?.pty.ptyId ?? null,
      getForegroundProcess: (ptyId) => this.ptyController!.getForegroundProcess(ptyId),
      hasChildProcesses: (ptyId) =>
        this.ptyController!.hasChildProcesses?.(ptyId) ?? Promise.resolve(false),
      subscribeToData: (ptyId, listener) => this.subscribeToTerminalData(ptyId, listener),
      readRecentOutput: (ptyId) => this.recentPtyOutputById.get(ptyId)?.read(),
      write: (ptyId, data) => this.ptyController?.write(ptyId, data)
    }
  }

  async prefetchManagedWorktreeCreateBase(args: {
    repoSelector: string
    baseBranch?: string
  }): Promise<void> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }

    const repo = await this.resolveRepoSelector(args.repoSelector)
    const store = this.requireStore()
    const baseBranch = await prefetchWorktreeCreateBase({
      repo,
      baseBranch: args.baseBranch,
      runtime: this,
      gitOptions: getWorktreeCreatePrefetchGitOptions(store, repo)
    })
    if (baseBranch) {
      try {
        await prepareWorktreeCreateForRepo(store, repo, baseBranch)
      } catch {
        // Why: speculative preparation is an optimistic warm-up; the real create path reports failures.
      }
    }
  }
}
