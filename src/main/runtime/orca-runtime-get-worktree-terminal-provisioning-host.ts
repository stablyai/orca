// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithActivateManagedWorktree } from './orca-runtime-activate-managed-worktree'
import type {
  WorktreeProvisionTerminalOptions,
  WorktreeTerminalProvisioningHost
} from './runtime-worktree-terminal-provisioning'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import {
  waitForWorktreeStartupDraft,
  type WorktreeStartupReadinessHost
} from './runtime-worktree-startup-readiness'
import { prefetchWorktreeCreateBase } from '../worktree-create-base-prefetch'
import { prepareWorktreeCreateForRepo } from '../worktree-create-preparation'
import { getWorktreeCreatePrefetchGitOptions } from '../project-runtime-git-options'
import type { TuiAgent } from '../../shared/tui-agent'

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

  /**
   * Waits for `agent`'s own composer-mount marker (the same PTY-output scanner that gates the
   * editable "start workspace from issue" draft paste) instead of the generic tui-idle signal,
   * which fires on OSC-title idle and can resolve while the TUI is still on its splash screen.
   * `timeoutMs`, when given, caps the agent's own hard timeout (never extends it) so a caller
   * with a short overall budget isn't blocked past it by this wait alone.
   *
   * Always resolves — including on a `getWorktreeStartupReadinessHost` failure (e.g. the PTY
   * tore down between placement and this call) — the same "proceed anyway" contract
   * `pasteWorktreeStartupDraftWhenReady` already relies on `.catch` for. Resolves `false` on
   * any of those non-ready outcomes; callers should treat that as best effort, not a failure.
   */
  async waitForAgentComposerReady(
    handle: string,
    agent: TuiAgent,
    timeoutMs?: number
  ): Promise<boolean> {
    try {
      const ptyId = await waitForWorktreeStartupDraft(
        this.getWorktreeStartupReadinessHost(),
        handle,
        agent,
        timeoutMs
      )
      return ptyId !== null
    } catch {
      return false
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
      prepareCheckout: (base) => prepareWorktreeCreateForRepo(store, repo, base)
    })
  }
}
