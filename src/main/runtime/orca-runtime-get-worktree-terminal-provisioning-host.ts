// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithActivateManagedWorktree } from './orca-runtime-activate-managed-worktree'
import type { WorktreeTerminalProvisioningHost } from './runtime-worktree-terminal-provisioning'
import type { WorktreeStartupReadinessHost } from './runtime-worktree-startup-readiness'
import { prefetchWorktreeCreateBase } from '../worktree-create-base-prefetch'
import { prepareWorktreeCreateForRepo } from '../worktree-create-preparation'
import { getWorktreeCreatePrefetchGitOptions } from '../project-runtime-git-options'
import { resolveWorktreeStartupClaudeAccount } from './runtime-worktree-startup-claude-account'
import type { Worktree } from '../../shared/worktree/types'
import {
  navigationTargetsHost,
  type RuntimeNavigationTarget
} from '../../shared/runtime-navigation'

export class OrcaRuntimeWithGetWorktreeTerminalProvisioningHost extends OrcaRuntimeWithActivateManagedWorktree {
  protected shouldProvisionWorktreeInBackground(navigation?: RuntimeNavigationTarget): boolean {
    return (
      navigationTargetsHost(navigation ?? 'host') &&
      (!this.notifier || this.graphStatus !== 'ready' || !this.getAvailableAuthoritativeWindow())
    )
  }

  protected getWorktreeTerminalProvisioningHost(
    createdWorktree?: Worktree
  ): WorktreeTerminalProvisioningHost {
    return {
      canSpawn: () => Boolean(this.ptyController?.spawn),
      createTerminal: (selector, options) =>
        this.createTerminal(selector, options, createdWorktree),
      splitTerminal: (handle, options) => this.splitTerminal(handle, options, createdWorktree),
      setTabTitle: async (handle, title) => {
        const { worktreeId, tabId } = this.getProvisionedTerminalTab(handle)
        // Why not renameTerminal: it writes the pane's title, stamped to outrank every later
        // agent title, which would hide the agent's own titles and status for the pane's life.
        this.notifier?.renameTerminal(tabId, title, { recordInteraction: false })
        if (!this.getAvailableAuthoritativeWindow()) {
          this.persistHeadlessTerminalTitle(worktreeId, tabId, title)
          this.applyHeadlessSessionTabPropsToSnapshot(worktreeId, tabId, { title })
        }
      },
      setTabColor: async (handle, color) => {
        const { worktreeId, tabId } = this.getProvisionedTerminalTab(handle)
        await this.setMobileSessionTabProps(`id:${worktreeId}`, { tabId, color })
      },
      getSettings: () => this.requireStore().getSettings(),
      getPtyId: (handle) => this.getLivePtyForHandle(handle)?.pty.ptyId,
      recordSetupCompletionToken: (ptyId, token) =>
        this.setupCompletionTokenByPtyId.set(ptyId, token)
    }
  }

  protected resolveStartupClaudeAccount(
    request: Parameters<typeof resolveWorktreeStartupClaudeAccount>[0]['request'],
    createRouteKind: Parameters<typeof resolveWorktreeStartupClaudeAccount>[0]['createRouteKind']
  ): string | undefined {
    return resolveWorktreeStartupClaudeAccount({
      request,
      createRouteKind,
      canSpawn: Boolean(this.ptyController?.spawn),
      listClaudeAccounts: () => this.getAccountsSnapshot().claude
    })
  }

  protected getProvisionedTerminalTab(handle: string): { worktreeId: string; tabId: string } {
    const pty = this.getLivePtyForHandle(handle)?.pty
    if (pty?.tabId) {
      return { worktreeId: pty.worktreeId, tabId: pty.tabId }
    }
    // Why: once the window's graph sync adopts the handle it names the window's leaf, not the
    // runtime's pty, as renameTerminal also resolves it.
    const { leaf } = this.getLiveLeafForHandle(handle)
    return { worktreeId: leaf.worktreeId, tabId: leaf.tabId }
  }

  protected getWorktreeStartupReadinessHost(): WorktreeStartupReadinessHost {
    return {
      getPtyId: (handle) => this.getLivePtyForHandle(handle)?.pty.ptyId ?? null,
      getForegroundProcess: (ptyId) => this.ptyController!.getForegroundProcess(ptyId),
      hasChildProcesses: (ptyId) =>
        this.ptyController!.hasChildProcesses?.(ptyId) ?? Promise.resolve(false),
      subscribeToData: (ptyId, listener) => this.subscribeToTerminalData(ptyId, listener),
      readRecentOutput: (ptyId) => this.recentPtyOutputById.get(ptyId)?.read(),
      write: (ptyId, data, inputKind) => this.ptyController?.write(ptyId, data, inputKind)
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
    await prefetchWorktreeCreateBase({
      repo,
      baseBranch: args.baseBranch,
      runtime: this,
      gitOptions: getWorktreeCreatePrefetchGitOptions(store, repo),
      prepareCheckout: (base, beforeMaterialization) =>
        prepareWorktreeCreateForRepo(store, repo, base, beforeMaterialization)
    })
  }
}
