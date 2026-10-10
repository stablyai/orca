// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithRemoveManagedWorktree } from './orca-runtime-remove-managed-worktree'
import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  RemoveManagedWorktreeOptions,
  RuntimeWorktreeRemovalTarget
} from './runtime-worktree-selection'
import { resolveRuntimeWorktreeRemovalTarget } from './runtime-worktree-removal-target'
import type { RuntimeStore } from './runtime-store-contract'
import type {
  ForceDeleteWorktreeBranchResult,
  RemoveWorktreeResult
} from '../../shared/worktree/create-types'
import type { RuntimeTerminalRename } from '../../shared/runtime-types'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import { terminalShellOverrideRefusal } from './terminal-shell-override-host-support'
import { resolveTerminalStartupCwd } from '../../shared/terminal-startup-cwd'
import { resolveLocalProjectRuntimeForWorktreeId } from '../local-project-runtime-resolution'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../shared/execution-host'
import {
  purgeRemovedWorktreeHostState,
  removeRuntimeWorktreeMetadataAndHistory
} from './worktree-removal-host-state-purge'
import {
  resumeInterruptedWorktreeRemovals,
  retryFailedWorktreeRemoval,
  waitForPendingWorktreeRemoval
} from '../worktree-background-removal'
import { interruptedLocalWorktreeRemovalJob } from './runtime-interrupted-local-worktree-removal'
import { retryFailedRemovalUnlessRegistered } from '../worktree-removal-table'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { resolveQoderTerminalCommandForWorkspace } from './qoder-terminal-command-resolution'
import { buildRuntimeAgentTerminalStartupOptions } from './runtime-agent-terminal-startup'

export class OrcaRuntimeWithResolveWorktreeRemovalTarget extends OrcaRuntimeWithRemoveManagedWorktree {
  protected async resolveWorktreeRemovalTarget(
    worktreeSelector: string,
    requiredHostId?: ExecutionHostId
  ): Promise<RuntimeWorktreeRemovalTarget> {
    return resolveRuntimeWorktreeRemovalTarget({
      selector: worktreeSelector,
      store: this.store,
      resolveWorktree: (selector) => this.resolveWorktreeSelector(selector),
      resolveExplicitWorktreeIdScoped: (worktreeId, hostId) =>
        this.resolveExplicitWorktreeIdScoped(worktreeId, hostId),
      ...(requiredHostId ? { requiredHostId } : {})
    })
  }

  /** Runs the same delete again for each local removal a quit or crash interrupted. */
  finishInterruptedWorktreeRemovals(): void {
    const store = this.store
    if (!store) {
      return
    }
    resumeInterruptedWorktreeRemovals((record) =>
      interruptedLocalWorktreeRemovalJob(record, this.localRemovalJobHost(store))
    )
  }

  /** The removal a request for this worktree waits on: the one still running. */
  protected joinPendingWorktreeRemoval(
    worktreeId: string,
    options: RemoveManagedWorktreeOptions
  ): Promise<RemoveWorktreeResult> | undefined {
    return waitForPendingWorktreeRemoval(worktreeId, parseExecutionHostId(options.hostId)?.id)
  }

  /**
   * Delete on the leftover of a local delete that failed after Git dropped the registration, while
   * Git's listing still does not register the path: runs that removal again. True when it did.
   */
  protected retryFailedLocalRemoval(
    route: { kind: string },
    target: { id: string; path: string },
    registeredWorktrees: readonly GitWorktreeInfo[],
    options: RemoveManagedWorktreeOptions
  ): boolean {
    const store = this.store
    if (route.kind !== 'local' || !store) {
      return false
    }
    const hostId = parseExecutionHostId(options.hostId)?.id
    const allowUnverifiedPtyStop = options.allowUnverifiedPtyStop === true
    return retryFailedRemovalUnlessRegistered(target.id, target.path, registeredWorktrees, () =>
      retryFailedWorktreeRemoval(target.id, hostId, (record) =>
        interruptedLocalWorktreeRemovalJob(record, {
          ...this.localRemovalJobHost(store),
          stopPtys: () =>
            this.stopPtysForDestructiveWorktreeRemoval(record.worktreeId, {
              allowUnverifiedStop: allowUnverifiedPtyStop
            })
        })
      )
    )
  }

  protected localRemovalJobHost(store: RuntimeStore) {
    return {
      store,
      acquireWatcherRemoval: this.acquireFileWatcherRemoval,
      closeWatchers: (path) => this.closeFileWatchersForRemoval(path),
      preservedBranchCleanup: this.preservedBranchCleanup,
      purge: ({ worktreeId, repoId }) =>
        this.purgeRemovedWorktree(store, worktreeId, repoId, LOCAL_EXECUTION_HOST_ID),
      onRemoved: ({ worktreeId, worktreePath }) =>
        this.emitWorktreeLifecycle({ kind: 'removed', worktreeId, path: worktreePath }),
      publish: (repoId) => this.publishWorktreeRemovalChange(repoId)
    }
  }

  // Host state every removal path drops once Git has let go of the checkout.
  // Resolves only after the Codex pretrust deletion landed, so a removal ack
  // cannot precede the trust table purge.
  protected purgeRemovedWorktree(
    store: RuntimeStore,
    worktreeId: string,
    repoId: string,
    removalHostId?: ExecutionHostId
  ): Promise<void> {
    return purgeRemovedWorktreeHostState(this, store, worktreeId, repoId, removalHostId)
  }

  protected removeWorktreeMetadataAndHistory(
    store: RuntimeStore,
    worktreeId: string,
    hostId?: ExecutionHostId
  ): Promise<void> {
    return removeRuntimeWorktreeMetadataAndHistory(this, store, worktreeId, hostId)
  }

  async forceDeletePreservedBranch(
    worktreeSelector: string,
    branchName: string,
    expectedHead: string,
    hostId?: string
  ): Promise<ForceDeleteWorktreeBranchResult> {
    return this.preservedBranchCleanup.forceDelete(
      worktreeSelector,
      branchName,
      expectedHead,
      hostId
    )
  }

  async renameTerminal(handle: string, title: string | null): Promise<RuntimeTerminalRename> {
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      pty.pty.title = title
      // Why: a manual rename must outrank later agent OSC title updates (which
      // win by timestamp), so stamp it as the freshest title.
      pty.pty.titleUpdatedAt = Date.now()
      this.touchMobileSessionSnapshotsForPty(pty.pty.ptyId)
      // Why: without a renderer the rename only lived on the live pty and was
      // lost on restart. Persist customTitle so a headless rebuild keeps it.
      if (!this.notifier?.renameTerminal && pty.pty.tabId) {
        this.persistHeadlessTerminalTitle(pty.pty.worktreeId, pty.pty.tabId, title)
      }
      for (const leaf of this.leaves.values()) {
        if (leaf.ptyId === pty.pty.ptyId) {
          this.notifier?.renameTerminal(leaf.tabId, title)
          return { handle, tabId: leaf.tabId, title }
        }
      }
      const tabId = pty.pty.tabId ?? pty.record.tabId
      // A notifier can exist before its pane graph; retain the rename on the known tab.
      if (this.notifier?.renameTerminal && tabId) {
        this.persistHeadlessTerminalTitle(pty.pty.worktreeId, tabId, title)
        this.notifier.renameTerminal(tabId, title)
      }
      return { handle, tabId, title }
    }
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    this.notifier?.renameTerminal(leaf.tabId, title)
    return { handle, tabId: leaf.tabId, title }
  }

  protected async resolveAgentTerminalCreateOptions(
    workspace: TerminalWorkspaceLaunchScope,
    opts: TerminalCreateOptions
  ): Promise<TerminalCreateOptions> {
    const launch = await this.buildAgentTerminalCreateOptions(workspace, opts)
    return resolveQoderTerminalCommandForWorkspace(
      launch,
      workspace,
      this.store,
      this.getAgentLaunchPlatformForWorkspace(workspace)
    )
  }

  protected async buildAgentTerminalCreateOptions(
    workspace: TerminalWorkspaceLaunchScope,
    opts: TerminalCreateOptions
  ): Promise<TerminalCreateOptions> {
    // Before any early return: every create lane funnels through here, and a host that cannot
    // apply the requested shell must refuse rather than spawn its default one.
    const shellRefusal = terminalShellOverrideRefusal({
      shellOverride: opts.shellOverride,
      connectionId: workspace.connectionId,
      platform: process.platform,
      projectRuntime:
        opts.shellOverride && this.store
          ? resolveLocalProjectRuntimeForWorktreeId(this.store, workspace.id)
          : undefined,
      // Same resolution as the spawn lanes below, so the refusal judges the cwd the PTY gets.
      cwd: resolveTerminalStartupCwd(workspace.path, opts.cwd) ?? workspace.path,
      workspacePath: workspace.path
    })
    if (shellRefusal) {
      throw shellRefusal
    }
    // Why: raw shell commands like `codex exec` must remain user-authored shell.
    // Only unmanaged, repo-backed, bare agent launches get Settings defaults.
    const callerSuppliedLaunch =
      opts.env ||
      opts.launchConfig ||
      opts.launchAgent ||
      opts.startupCommandDelivery ||
      opts.claudeAgentTeamsSourceCommand
    const store = this.store
    if (opts.startupAgent) {
      // Why: falling through unresolved would spawn a bare shell that can only time
      // out waiting for an agent. A caller-supplied launch contradicts the agent:
      // `command` would be overwritten, `resumeProviderSession` would pair resume
      // identity with a fresh launch.
      if (callerSuppliedLaunch || opts.command || opts.resumeProviderSession) {
        throw new Error(
          `startupAgent ${opts.startupAgent} cannot combine with a caller-supplied launch.`
        )
      }
      if (!store) {
        throw new Error('runtime_unavailable')
      }
    } else if (callerSuppliedLaunch || !store || !opts.command || !workspace.repo) {
      return opts
    }

    return buildRuntimeAgentTerminalStartupOptions(
      workspace,
      opts,
      store.getSettings(),
      this.getAgentLaunchPlatformForWorkspace(workspace),
      this.toAgentSessionOptions(opts.launchPreferences),
      this.runtimeId
    )
  }
}
