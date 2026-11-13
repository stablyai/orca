import type { RuntimeWorktreeLifecycleEvent } from '../lifecycle/worktree-lifecycle-event'
import type { AutomationsChangedPayload } from '../../../../shared/runtime-client-events'
import type { WorkspaceCleanupRunFinishedEvent } from '../../../../shared/workspace-cleanup/workspace-cleanup-run'
import { wakeFolderRepoGitUpgradeWatch } from '../../../ipc/folder-repo-git-upgrade-wake'
import { runWorktreeChangeInvalidators } from '../../../ipc/worktrees/listing/worktree-change-invalidators'
import type { WorktreeSortOrderUpdate } from '../../../../shared/worktree/sort-order-update'
import type { WorkspaceMetadataSet } from '../../../../shared/worktree/workspace-metadata-set'
import { NativeChatLaunchDraftOwner } from '../../agent-session/launch/native-chat-launch-draft-owner'

export abstract class RuntimeWorkspaceChangeEvents extends NativeChatLaunchDraftOwner {
  protected abstract pruneUnregisteredWorktreeScans(): void

  notifyWorktreesChanged(
    repoId: string,
    options?: {
      invalidateGitScans?: boolean
      sortOrderOnly?: boolean
      sortOrders?: WorktreeSortOrderUpdate[]
    }
  ): void {
    if (options?.invalidateGitScans !== false) {
      runWorktreeChangeInvalidators(repoId)
    }
    if (options) {
      const { sortOrders: _sortOrders, ...notifierOptions } = options
      this.notifier?.worktreesChanged(repoId, undefined, notifierOptions)
    } else {
      this.notifier?.worktreesChanged(repoId)
    }
    this.emitClientEvent({
      type: 'worktreesChanged',
      repoId,
      ...(options?.sortOrderOnly === true ? { sortOrderOnly: true } : {}),
      ...(options?.sortOrderOnly === true && options.sortOrders
        ? { sortOrders: options.sortOrders }
        : {})
    })
  }

  /** One workspace's metadata, addressed: clients patch that row instead of refetching its repo. Interim transport for the record. */
  publishWorkspaceMetadataSet(set: WorkspaceMetadataSet): void {
    this.notifier?.workspaceMetadataSet?.(set)
    this.emitClientEvent({ type: 'workspaceMetadataSet', ...set })
  }

  /** Unlike coarse repoId-only changes, lifecycle events name the workspace; removals resolve only id/path before teardown. */
  onWorktreeLifecycle(listener: (event: RuntimeWorktreeLifecycleEvent) => void): () => void {
    return this.worktreeLifecycleEvents.on(listener)
  }

  protected emitWorktreeLifecycle(event: RuntimeWorktreeLifecycleEvent): void {
    this.worktreeLifecycleEvents.emit(event)
  }

  protected notifyReposChanged(): void {
    this.pruneUnregisteredWorktreeScans()
    wakeFolderRepoGitUpgradeWatch()
    this.notifier?.reposChanged()
    this.emitClientEvent({ type: 'reposChanged' })
    // Automation owners are projected from projects, so open lists must re-read them (STA-12812).
    this.notifyAutomationsChanged({ reason: 'definition' })
  }

  // Automation/IPC writes need a public stream entry; older clients drop this unknown event without negotiation.
  notifyAutomationsChanged(payload: AutomationsChangedPayload = {}): void {
    this.notifier?.automationsChanged?.(payload)
    this.emitClientEvent({ type: 'automationsChanged', ...payload })
  }

  /** The cleanup runner finished a run on this host; clients may toast. */
  notifyWorkspaceCleanupRunFinished(run: WorkspaceCleanupRunFinishedEvent['run']): void {
    this.emitClientEvent({ type: 'workspaceCleanupRunFinished', run })
  }
}
