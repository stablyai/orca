import { applyRemoteViewerLaunchEnv } from '../remote-viewer-launch-env'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import { OrcaRuntimeWithRemoveManagedWorktree } from './workspace-removal'
import type {
  RemoveManagedWorktreeOptions,
  RuntimeWorktreeRemovalTarget
} from '../runtime-worktree-selection'
import { resolveRuntimeWorktreeRemovalTarget } from '../runtime-worktree-removal-target'
import type { RuntimeStore } from '../runtime-store-contract'
import { splitWorktreeId, worktreeIdsEqual } from '../../../shared/worktree/id'
import { hasWorktreeRemovalRepoOwnerOnOtherHost } from '../../worktree-removal-repo-owner'
import {
  dropRemovedWorktreeProcessState,
  pruneRemovedWorktreeSnapshots
} from '../../worktree-removal-process-cleanup'
import { forgetFailedAgentLaunches } from '../../agent-launch/agent-launch-pane-attachment'
import { closeClientHostedBrowserPagesForWorktree } from '../worktree-browser-client-page-close'
import { teardownStops } from '../owned-session-teardown-policy'
import { deleteRemovedOwnerBrowserProfile } from '../browser-host/managed-browser-profile-removal'
import type {
  ForceDeleteWorktreeBranchResult,
  RemoveWorktreeResult
} from '../../../shared/worktree/create-types'
import type {
  RuntimeTerminalRename,
  RuntimeTerminalSetPaneTitle
} from '../../../shared/runtime-types'
import type { TerminalWorkspaceLaunchScope } from '../runtime-legacy-worker-terminal-recovery-types'
import type { TerminalCreateOptions } from '../runtime-terminal-contracts'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { invalidateAuthorizedRootsCacheForRepo } from '../../ipc/registered-worktree-roots-scoped-invalidation'
import {
  resumeInterruptedWorktreeRemovals,
  retryFailedWorktreeRemoval,
  waitForPendingWorktreeRemoval
} from '../../worktree-background-removal'
import { interruptedLocalWorktreeRemovalJob } from '../runtime-interrupted-local-worktree-removal'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { retryFailedRemovalUnlessRegistered } from '../../worktree-removal-leftover'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import {
  resolveAgentTerminalCreateOptions,
  withHostAccountLaunchEnv
} from '../runtime-agent-terminal-startup'
import { removeWorktreeMetaRow } from '../../persistence/host-qualified-worktree-meta'

export abstract class OrcaRuntimeWithResolveWorktreeRemovalTarget extends OrcaRuntimeWithRemoveManagedWorktree {
  protected abstract resolveExplicitWorktreeIdScoped(
    worktreeId: string,
    requiredHostId?: ExecutionHostId
  ): Promise<ResolvedWorktree | null>
  protected abstract cancelScheduledMobileSessionTabsChanged(worktreeId: string): void
  protected abstract notifyMobileSessionTabsRemoved(worktreeId: string): void

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
   * Delete on a local delete that failed after Git dropped the registration, while Git's listing
   * still does not register the path: refuses while the folder is there, else finishes that removal.
   * True when it did.
   */
  protected async retryFailedRemoval(
    route: { kind: string },
    target: { id: string; path: string },
    registeredWorktrees: readonly GitWorktreeInfo[],
    options: RemoveManagedWorktreeOptions
  ): Promise<boolean> {
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
  protected purgeRemovedWorktree(
    store: RuntimeStore,
    worktreeId: string,
    repoId: string,
    removalHostId?: ExecutionHostId
  ): void {
    this.clearOptimisticReconcileToken(worktreeId)
    this.removeWorktreeMetadataAndHistory(store, worktreeId, removalHostId)
    this.invalidateResolvedWorktreeCache()
    this.invalidateWorktreeScanCacheForRepo(repoId)
    invalidateAuthorizedRootsCacheForRepo(store, repoId)
  }

  removeWorktreeMetadataAndHistory(
    store: RuntimeStore,
    worktreeId: string,
    hostId?: ExecutionHostId
  ): void {
    // Why: worktree IDs are path-derived and can be recreated, so removal must
    // purge history and process-local caches before the ID points at new state.
    const persistedHostId = store.getWorktreeMeta(worktreeId)?.hostId
    const repoId = splitWorktreeId(worktreeId)?.repoId
    const preservesSameIdOwner = Boolean(
      hostId &&
      ((persistedHostId && persistedHostId !== hostId) ||
        (repoId && hasWorktreeRemovalRepoOwnerOnOtherHost(store, repoId, hostId)))
    )
    const acceptedRendererSnapshot = this.acceptedRendererMobileSnapshotByWorktree.get(worktreeId)
    const storedSnapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    removeWorktreeMetaRow(store, worktreeId, hostId)
    // Why outside the same-id gate: retirement is per host and per pane, so a surviving owner keeps its own.
    this.dropAgentStatusForRemovedWorktreeFn?.(worktreeId, hostId ?? persistedHostId)
    if (!preservesSameIdOwner) {
      // A paired PTY can outlive the delete acknowledgement; it must not be
      // rescued into a newly-created occupant of the same path-derived ID.
      for (const ptyId of this.pairedRendererSessionOwnedPtyIds) {
        const ptyWorktreeId = this.ptysById.get(ptyId)?.worktreeId
        if (ptyWorktreeId && worktreeIdsEqual(ptyWorktreeId, worktreeId)) {
          this.pairedRendererSessionOwnedPtyIds.delete(ptyId)
        }
      }
      const removedPublicationEpoch =
        acceptedRendererSnapshot?.publicationEpoch ??
        storedSnapshot?.publicationEpoch ??
        this.rendererGeneration ??
        undefined
      this.removedMobileSessionWorktreeIds.set(
        worktreeId,
        removedPublicationEpoch ? { removedPublicationEpoch } : {}
      )
      this.mobileSessionTabsByWorktree.delete(worktreeId)
      this.mobileSessionTabsAgentStatusHeartbeat.removeWorktree(worktreeId)
      this.acceptedRendererMobileSnapshotByWorktree.delete(worktreeId)
      this.cancelScheduledMobileSessionTabsChanged(worktreeId)
      this.notifyMobileSessionTabsRemoved(worktreeId)
      dropRemovedWorktreeProcessState(worktreeId)
      this.releaseRemovedWorktreeHostSessions(worktreeId, 'worktree-removal')
    }
    const snapshotDirectory = store.getProfileStorageDirectory?.()
    if (snapshotDirectory) {
      pruneRemovedWorktreeSnapshots(snapshotDirectory, worktreeId, hostId)
    }
  }

  // Every removal path calls this (desktop IPC, runtime, project); PTYs and chats stop before.
  // Headless pages are main-process windows that otherwise outlive the worktree.
  releaseRemovedWorktreeHostSessions(
    worktreeId: string,
    entryPoint: 'worktree-removal' | 'folder-removal' | 'project-removal'
  ): void {
    if (teardownStops(entryPoint, 'launch')) {
      forgetFailedAgentLaunches(worktreeId, null)
    }
    if (!teardownStops(entryPoint, 'host-browser')) {
      return
    }
    const backend = this.offscreenBrowserBackend
    for (const tab of backend ? (this.agentBrowserBridge?.tabList?.(worktreeId).tabs ?? []) : []) {
      void backend?.closeTab(tab.browserPageId).catch(() => {})
    }
    closeClientHostedBrowserPagesForWorktree(this, worktreeId)
    deleteRemovedOwnerBrowserProfile({ kind: 'worktree', id: worktreeId })
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
    // Switch point: a terminal main owns is renamed in main's layout, with or without a window.
    const mainRename = ORCA_LAYOUT_OWNER_IS_MAIN
      ? await this.renameTerminalInMainLayout(handle, title)
      : null
    if (mainRename) {
      return mainRename
    }
    const normalizedTitle = title?.trim() || null
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      // Why: not pty.title — that is the process's own title evidence, and a name there reads as
      // the shell taking the pane back (#20626).
      pty.pty.customTitle = normalizedTitle
      pty.pty.manualTitle = normalizedTitle
      const recordedTabId = (): string | null => this.paneOfPty(pty.pty).tabId
      this.touchMobileSessionSnapshotsForPty(pty.pty.ptyId)
      const layoutTabId =
        recordedTabId() ??
        pty.pty.tabId ??
        this.resolveRealTabIdForPty(pty.pty.ptyId, pty.pty.worktreeId, handle)
      if (!ORCA_LAYOUT_OWNER_IS_MAIN && layoutTabId && !pty.pty.tabId) {
        pty.pty.tabId = layoutTabId
      }
      const tabId = layoutTabId ?? pty.record.tabId
      this.rememberManualTerminalTitle(tabId, normalizedTitle)
      // Why: without a renderer the rename only lived on the live pty and was
      // lost on restart. Persist customTitle so a headless rebuild keeps it.
      if (!this.notifier?.renameTerminal && layoutTabId) {
        this.persistHeadlessTerminalTitle(pty.pty.worktreeId, layoutTabId, normalizedTitle)
        // Why: paired desktops rank their own saved-session title above the live one, so the
        // name has to be published as manual or a resumed session hides it (#29975).
        this.applyHeadlessSessionTabPropsToSnapshot(pty.pty.worktreeId, layoutTabId, {
          customTitle: normalizedTitle,
          // Why: a name set while the pane slept lives in the snapshot title; a reset must drop it.
          ...(normalizedTitle === null
            ? {
                title: this.headlessTerminalFallbackTitle(pty.pty.worktreeId, layoutTabId)
              }
            : {})
        })
      }
      // Why: a window notifier only renames the open tab. The session alias still
      // has to be stored, or Agent History loses the name after the tab closes.
      for (const leaf of this.leaves.values()) {
        if (leaf.ptyId === pty.pty.ptyId) {
          this.rememberManualTerminalTitle(leaf.tabId, normalizedTitle)
          if (this.notifier?.renameTerminal) {
            this.persistHeadlessTerminalTitle(pty.pty.worktreeId, leaf.tabId, normalizedTitle)
          }
          this.rememberTerminalSessionTitle(leaf.tabId, handle, normalizedTitle)
          this.notifier?.renameTerminal(leaf.tabId, normalizedTitle)
          return { handle, tabId: leaf.tabId, title: normalizedTitle }
        }
      }
      // A notifier can exist before its pane graph; retain the rename on the known tab.
      if (this.notifier?.renameTerminal && tabId) {
        this.persistHeadlessTerminalTitle(pty.pty.worktreeId, tabId, normalizedTitle)
        this.rememberTerminalSessionTitle(tabId, handle, normalizedTitle)
        this.notifier.renameTerminal(tabId, normalizedTitle)
      } else {
        this.rememberTerminalSessionTitle(tabId, handle, normalizedTitle)
      }
      return { handle, tabId, title: normalizedTitle }
    }
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    const boundPty = leaf.ptyId ? this.ptysById.get(leaf.ptyId) : null
    if (boundPty) {
      boundPty.customTitle = normalizedTitle
      boundPty.manualTitle = normalizedTitle
      this.touchMobileSessionSnapshotsForPty(boundPty.ptyId)
    }
    this.rememberManualTerminalTitle(leaf.tabId, normalizedTitle)
    this.persistHeadlessTerminalTitle(leaf.worktreeId, leaf.tabId, normalizedTitle)
    this.rememberTerminalSessionTitle(leaf.tabId, handle, normalizedTitle)
    this.notifier?.renameTerminal(leaf.tabId, normalizedTitle)
    this.touchMobileSessionTabsForWorktree(leaf.worktreeId, { immediate: true })
    return { handle, tabId: leaf.tabId, title: normalizedTitle }
  }

  protected rememberManualTerminalTitle(tabId: string | null, title: string | null): void {
    if (!tabId) {
      return
    }
    const inMemoryTab = this.tabs.get(tabId)
    if (!inMemoryTab) {
      return
    }
    inMemoryTab.customTitle = title
    if (title !== null) {
      inMemoryTab.title = title
    }
  }

  /** Names one pane of a split; the tab's own name is untouched. */
  async setPaneTitle(handle: string, title: string | null): Promise<RuntimeTerminalSetPaneTitle> {
    // Switch point: a pane main owns is named in main's layout, with or without a window.
    const mainTitle = ORCA_LAYOUT_OWNER_IS_MAIN
      ? await this.setPaneTitleInMainLayout(handle, title)
      : null
    if (mainTitle) {
      return mainTitle
    }
    const { leaf } = this.getLiveLeafForHandle(handle)
    if (!this.getAvailableAuthoritativeWindow() || !this.notifier?.setPaneTitle) {
      throw new Error('Pane titles require a running Orca desktop with set-pane-title support')
    }
    const normalizedTitle = title?.trim() || null
    if (!this.notifier.setPaneTitle(leaf.tabId, leaf.leafId, normalizedTitle)) {
      throw new Error('runtime_unavailable')
    }
    return { handle, tabId: leaf.tabId, leafId: leaf.leafId, title: normalizedTitle }
  }

  async resolveAgentTerminalCreateOptions(
    workspace: TerminalWorkspaceLaunchScope,
    opts: TerminalCreateOptions
  ): Promise<TerminalCreateOptions> {
    const resolvedLaunch = await resolveAgentTerminalCreateOptions(workspace, opts, {
      store: this.store,
      hostIdentity: this.runtimeId,
      toSessionOptions: (preferences) => this.toAgentSessionOptions(preferences)
    })
    const launch = applyRemoteViewerLaunchEnv(resolvedLaunch, opts.terminalImageViewerSupported)
    // An SSH workspace's shell runs on that machine, where this distro's account paths mean nothing.
    return workspace.connectionId
      ? launch
      : withHostAccountLaunchEnv(opts, launch, this.accounts.hostLaunchEnvFor(launch.launchAgent))
  }
}
