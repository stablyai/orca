import type { RuntimeRemoteFetchController } from '../../runtime-remote-fetch-controller'
import type { TerminalSplitOptions } from '../../terminal/launch/terminal-split-surface'
import type { RuntimeTerminalSplit } from '../../../../shared/runtime-terminal-contracts'
import { OrcaRuntimeWithActivateManagedWorktree } from '../workspace-activation'
import type { WorktreeTerminalProvisioningHost } from '../../runtime-worktree-terminal-provisioning'
import type { WorktreeStartupReadinessHost } from '../../runtime-worktree-startup-readiness'
import { prefetchWorktreeCreateBase } from '../../../worktree-create-base-prefetch'
import { prepareWorktreeCreateForRepo } from '../../../worktree-create-preparation'
import { getWorktreeCreatePrefetchGitOptions } from '../../../project-runtime-git-options'
import type { Worktree } from '../../../../shared/worktree/types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { LayoutApplyReply } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import type { WindowLayoutCommand } from '../../runtime-layout-apply'
import {
  navigationTargetsHost,
  type RuntimeNavigationTarget
} from '../../../../shared/runtime-navigation'

export abstract class OrcaRuntimeWithGetWorktreeTerminalProvisioningHost extends OrcaRuntimeWithActivateManagedWorktree {
  abstract applyLayoutCommand(command: WindowLayoutCommand): Promise<LayoutApplyReply>

  abstract splitTerminal(
    handle: string,
    opts?: TerminalSplitOptions,
    createdWorktree?: Worktree
  ): Promise<RuntimeTerminalSplit>
  abstract resolveRemoteTrackingBase(
    ...args: Parameters<RuntimeRemoteFetchController['resolveRemoteTrackingBase']>
  ): ReturnType<RuntimeRemoteFetchController['resolveRemoteTrackingBase']>
  abstract hasRemoteTrackingRef(
    ...args: Parameters<RuntimeRemoteFetchController['hasRemoteTrackingRef']>
  ): ReturnType<RuntimeRemoteFetchController['hasRemoteTrackingRef']>
  abstract getOrStartRemoteTrackingBaseRefresh(
    ...args: Parameters<RuntimeRemoteFetchController['getOrStartRemoteTrackingBaseRefresh']>
  ): ReturnType<RuntimeRemoteFetchController['getOrStartRemoteTrackingBaseRefresh']>
  abstract fetchRemoteWithCache(
    ...args: Parameters<RuntimeRemoteFetchController['fetchRemoteWithCache']>
  ): ReturnType<RuntimeRemoteFetchController['fetchRemoteWithCache']>

  protected shouldProvisionWorktreeInBackground(navigation?: RuntimeNavigationTarget): boolean {
    return (
      navigationTargetsHost(navigation ?? 'host') &&
      (!this.notifier || this.graphStatus !== 'ready' || !this.getAvailableAuthoritativeWindow())
    )
  }

  protected getWorktreeTerminalProvisioningHost(
    createdWorktree?: Worktree
  ): WorktreeTerminalProvisioningHost {
    // Switch point: main writes a default tab's look itself, window or none.
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      return this.getLayoutOwnerTerminalProvisioningHost(createdWorktree)
    }
    return {
      canSpawn: () => Boolean(this.ptyController?.spawn),
      createTerminal: (selector, options) =>
        this.createTerminal(selector, options, createdWorktree),
      setTabTitle: async (handle, title) => {
        const { worktreeId, tabId } = this.getProvisionedTerminalTab(handle)
        // Why not renameTerminal: it writes the pane's title, stamped to outrank every later
        // agent title, which would hide the agent's own titles and status for the pane's life.
        this.notifier?.renameTerminal(tabId, title, { recordInteraction: false })
        if (!this.getAvailableAuthoritativeWindow()) {
          this.persistHeadlessTerminalTitle(worktreeId, tabId, title)
          this.applyHeadlessSessionTabPropsToSnapshot(worktreeId, tabId, {
            title,
            customTitle: title.trim() || null
          })
        }
      },
      setTabColor: async (handle, color) => {
        const { worktreeId, tabId } = this.getProvisionedTerminalTab(handle)
        await this.setMobileSessionTabProps(`id:${worktreeId}`, { tabId, color })
      },
      getPtyId: (handle) => this.getLivePtyForHandle(handle)?.pty.ptyId,
      recordSetupCompletionToken: (ptyId, token) =>
        this.setupCompletionTokenByPtyId.set(ptyId, token)
    }
  }

  private getLayoutOwnerTerminalProvisioningHost(
    createdWorktree?: Worktree
  ): WorktreeTerminalProvisioningHost {
    const applied = (reply: LayoutApplyReply): boolean => {
      if (!reply.ok) {
        console.warn('[worktree-create] main refused a default tab write:', reply.code)
      }
      return reply.ok
    }
    return {
      canSpawn: () => Boolean(this.ptyController?.spawn),
      createTerminal: (selector, options) =>
        this.createTerminal(selector, options, createdWorktree),
      setTabTitle: async (handle, title) => {
        const { worktreeId, tabId } = this.getProvisionedTerminalTab(handle)
        const ok = applied(
          await this.applyLayoutCommand({
            type: 'renameTab',
            workspace: worktreeId,
            tabId,
            kind: 'custom',
            title
          })
        )
        // The window draws the title from main's frame; a headless phone still reads its snapshot (L238).
        if (ok && !this.getAvailableAuthoritativeWindow()) {
          this.applyHeadlessSessionTabPropsToSnapshot(worktreeId, tabId, {
            title,
            customTitle: title.trim() || null
          })
        }
      },
      setTabColor: async (handle, color) => {
        const { worktreeId, tabId } = this.getProvisionedTerminalTab(handle)
        const ok = applied(
          await this.applyLayoutCommand({
            type: 'setTabProps',
            workspace: worktreeId,
            tabId,
            color
          })
        )
        if (ok && !this.getAvailableAuthoritativeWindow()) {
          this.applyHeadlessSessionTabPropsToSnapshot(worktreeId, tabId, { color })
        }
      },
      applyDefaultTabs: async (worktreeId, tabs) => {
        const reply = await this.applyLayoutCommand({
          type: 'applyDefaultTabs',
          workspace: worktreeId,
          tabs
        })
        return applied(reply) && reply.ok ? (reply.result.createdTabs ?? []) : null
      },
      getPtyId: (handle) => this.getLivePtyForHandle(handle)?.pty.ptyId,
      recordSetupCompletionToken: (ptyId, token) =>
        this.setupCompletionTokenByPtyId.set(ptyId, token)
    }
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
