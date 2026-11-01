import type { OrcaRuntimeWithMergePreservedHeadlessMobileSessionTabs as MergePreservedHeadlessMobileSessionTabsMethods } from './mobile-session-preservation'
import type { OrcaRuntimeWithStoredMobileSnapshotHasStalePreservedTab as StoredMobileSnapshotHasStalePreservedTabMethods } from './mobile-session-publication-preservation'
import { OrcaRuntimeWithWriteOrchestrationPointerPty } from '../orchestration/terminal-authority/write-orchestration-pointer-pty'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { getMobileSessionSnapshotTabIdentityKeys } from '../mobile-session-tab-merge'

export abstract class OrcaRuntimeWithSyncMobileSessionTabs extends OrcaRuntimeWithWriteOrchestrationPointerPty {
  protected abstract buildPreservedHeadlessMobileSessionSnapshot(
    ...args: Parameters<
      MergePreservedHeadlessMobileSessionTabsMethods['buildPreservedHeadlessMobileSessionSnapshot']
    >
  ): ReturnType<
    MergePreservedHeadlessMobileSessionTabsMethods['buildPreservedHeadlessMobileSessionSnapshot']
  >

  protected abstract mergePreservedHeadlessMobileSessionTabs(
    ...args: Parameters<
      MergePreservedHeadlessMobileSessionTabsMethods['mergePreservedHeadlessMobileSessionTabs']
    >
  ): ReturnType<
    MergePreservedHeadlessMobileSessionTabsMethods['mergePreservedHeadlessMobileSessionTabs']
  >

  protected abstract releaseRuntimeSessionOwnershipForRendererRetiredTabs(
    ...args: Parameters<
      MergePreservedHeadlessMobileSessionTabsMethods['releaseRuntimeSessionOwnershipForRendererRetiredTabs']
    >
  ): ReturnType<
    MergePreservedHeadlessMobileSessionTabsMethods['releaseRuntimeSessionOwnershipForRendererRetiredTabs']
  >

  protected abstract storedMobileSnapshotHasStalePreservedTab(
    ...args: Parameters<
      StoredMobileSnapshotHasStalePreservedTabMethods['storedMobileSnapshotHasStalePreservedTab']
    >
  ): ReturnType<
    StoredMobileSnapshotHasStalePreservedTabMethods['storedMobileSnapshotHasStalePreservedTab']
  >

  // Returns the worktrees whose stored snapshot object changed during this
  // sync, so the caller can fan out only actually-changed worktrees.
  protected syncMobileSessionTabs(
    snapshots: RuntimeMobileSessionTabsSnapshot[] | undefined,
    unchangedWorktreeIds?: string[],
    resyncWorktreeIds = new Set<string>(),
    rendererGeneration?: string | null
  ): Set<string> {
    const changedWorktreeIds = new Set<string>()
    if (snapshots === undefined) {
      return changedWorktreeIds
    }
    // Immutable snapshots and the accept gate make reference identity detect actual changes without rebroadcasting unchanged resends.
    const blockedRecreatedWorktreeIds = new Set<string>()
    const acceptedSnapshots = snapshots.filter((snapshot) => {
      const fence = this.removedMobileSessionWorktreeIds.get(snapshot.worktree)
      if (!fence) {
        return true
      }
      const reject = (): false => {
        blockedRecreatedWorktreeIds.add(snapshot.worktree)
        fence.rejectedPublication = true
        return false
      }
      const currentMeta = this.store?.getWorktreeMeta(snapshot.worktree)
      if (!currentMeta) {
        return reject()
      }
      if (snapshot.worktreeInstanceId !== undefined) {
        // Catalog instanceId mismatch proves this is not the current occupant; no removed-id memory is needed.
        if (snapshot.worktreeInstanceId !== currentMeta.instanceId) {
          return reject()
        }
        // Successor identity closes the race; instanceId mismatch then fences old-occupant frames.
        this.removedMobileSessionWorktreeIds.delete(snapshot.worktree)
        return true
      }
      // Identity-less successor frames require a new live renderer generation; same-generation recreate remains fenced.
      if (
        (typeof rendererGeneration === 'string' &&
          snapshot.publicationEpoch !== rendererGeneration) ||
        snapshot.publicationEpoch === fence.removedPublicationEpoch
      ) {
        return reject()
      }
      return true
    })
    const before = new Map(this.mobileSessionTabsByWorktree)
    this.restoreLivePairedRendererSessionOwnedMobileTerminals(null, {
      missingSnapshotOnly: true,
      notify: false
    })
    // Scan each persisted host partition once per graph sync, not once per workspace.
    const worktreeSessionsToHydrate = new Map<string, WorkspaceSessionState | null>(
      this.getWorkspaceSessionHydrationTargets(Boolean(this.offscreenBrowserBackend))
    )
    if (this.offscreenBrowserBackend) {
      for (const snapshot of acceptedSnapshots) {
        if (!worktreeSessionsToHydrate.has(snapshot.worktree)) {
          worktreeSessionsToHydrate.set(snapshot.worktree, null)
        }
      }
    }
    // Empty renderer frames after HUB restart must retain SSH panes saved in this host partition.
    for (const [worktreeId, workspaceSession] of worktreeSessionsToHydrate) {
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
        allowAttachedWindow: true,
        onlyRuntimeOwnedTerminals: true,
        ...(workspaceSession ? { runtimeOwnedTerminalCandidateKnown: true, workspaceSession } : {})
      })
    }
    const nextWorktrees = new Set<string>()
    const incomingWorktreeIds = new Set(acceptedSnapshots.map((snapshot) => snapshot.worktree))
    for (const worktreeId of blockedRecreatedWorktreeIds) {
      nextWorktrees.add(worktreeId)
    }
    // Renderers omit unchanged snapshots; keep them live unless accepted state is missing or preserved runtime rows went stale, then request republish.
    for (const worktreeId of unchangedWorktreeIds ?? []) {
      const existing = this.mobileSessionTabsByWorktree.get(worktreeId)
      const accepted = this.acceptedRendererMobileSnapshotByWorktree.get(worktreeId)
      if (existing) {
        nextWorktrees.add(worktreeId)
      }
      // Do not request republish for fenced frames; every sync would request another equally fenced frame.
      if (!existing && this.removedMobileSessionWorktreeIds.get(worktreeId)?.rejectedPublication) {
        nextWorktrees.add(worktreeId)
        continue
      }
      if (
        existing &&
        accepted &&
        (existing.publicationEpoch === accepted.publicationEpoch ||
          existing.publicationEpoch.startsWith(`${accepted.publicationEpoch}:headless-merge:`)) &&
        existing.tabs.length >= accepted.rendererTabCount &&
        (existing.tabs.length === accepted.rendererTabCount ||
          !this.storedMobileSnapshotHasStalePreservedTab(
            existing,
            accepted.rendererTabIdentityKeys
          ))
      ) {
        continue
      }
      if (!incomingWorktreeIds.has(worktreeId)) {
        resyncWorktreeIds.add(worktreeId)
      }
      // Clear accepted pairs before republish or the still-retained accept gate rejects its frame.
      this.acceptedRendererMobileSnapshotByWorktree.delete(worktreeId)
    }
    for (const snapshot of acceptedSnapshots) {
      nextWorktrees.add(snapshot.worktree)
      const existing = this.mobileSessionTabsByWorktree.get(snapshot.worktree)
      // Order renderer frames by their own accepted pair; main-local version bumps must not reject newer renderer revisions.
      const accepted = this.acceptedRendererMobileSnapshotByWorktree.get(snapshot.worktree)
      if (
        accepted &&
        accepted.publicationEpoch === snapshot.publicationEpoch &&
        snapshot.snapshotVersion <= accepted.rendererVersion &&
        // Re-merge the exact accepted revision to prune stale host-only preservation; skip strictly older frames until a current resend.
        !(
          existing &&
          snapshot.snapshotVersion === accepted.rendererVersion &&
          this.storedMobileSnapshotHasStalePreservedTab(existing, accepted.rendererTabIdentityKeys)
        )
      ) {
        continue
      }
      this.nativeChatDraftResolutions.reconcile(snapshot)
      const launchDraftFencedSnapshot = this.nativeChatDraftResolutions.applyFence(snapshot)
      const fencedSnapshot = this.applyMobileSessionRetirementFences(launchDraftFencedSnapshot)
      this.releaseRuntimeSessionOwnershipForRendererRetiredTabs(fencedSnapshot, existing)
      const nextSnapshot = this.mergePreservedHeadlessMobileSessionTabs(fencedSnapshot, existing)
      // Keep stored versions strictly increasing past main-local bumps or clients discard accepted renderer content as stale.
      const storedVersion = existing
        ? Math.max(nextSnapshot.snapshotVersion, existing.snapshotVersion + 1)
        : nextSnapshot.snapshotVersion
      this.storeMobileSessionSnapshot(
        snapshot.worktree,
        storedVersion === nextSnapshot.snapshotVersion
          ? nextSnapshot
          : { ...nextSnapshot, snapshotVersion: storedVersion }
      )
      this.acceptedRendererMobileSnapshotByWorktree.set(snapshot.worktree, {
        publicationEpoch: snapshot.publicationEpoch,
        rendererVersion: snapshot.snapshotVersion,
        rendererTabCount: fencedSnapshot.tabs.length,
        rendererTabIdentityKeys: new Set(
          fencedSnapshot.tabs.flatMap((tab) => getMobileSessionSnapshotTabIdentityKeys(tab))
        )
      })
    }
    for (const [worktreeId, existing] of Array.from(this.mobileSessionTabsByWorktree)) {
      if (!nextWorktrees.has(worktreeId)) {
        const preserved = this.buildPreservedHeadlessMobileSessionSnapshot(existing)
        if (preserved) {
          // Equal publisher epoch and identical retained tab objects mean no content change; keep the entry to avoid no-op fanout.
          const preservedIsNoOp =
            preserved.publicationEpoch === existing.publicationEpoch &&
            preserved.tabs.length === existing.tabs.length &&
            preserved.tabs.every((tab, index) => tab === existing.tabs[index])
          if (!preservedIsNoOp) {
            this.storeMobileSessionSnapshot(worktreeId, preserved)
          }
          // Preserved entries are no longer renderer publications; the next renderer frame must re-merge even with a reused pair.
          this.acceptedRendererMobileSnapshotByWorktree.delete(worktreeId)
          nextWorktrees.add(worktreeId)
        } else {
          this.mobileSessionTabsByWorktree.delete(worktreeId)
          this.mobileSessionTabsAgentStatusHeartbeat.removeWorktree(worktreeId)
          this.acceptedRendererMobileSnapshotByWorktree.delete(worktreeId)
          // Cancel pending notices so an old snapshot cannot follow the removal frame.
          this.cancelScheduledMobileSessionTabsChanged(worktreeId)
          this.notifyMobileSessionTabsRemoved(worktreeId)
        }
      }
    }
    for (const [worktreeId, snapshot] of this.mobileSessionTabsByWorktree) {
      if (before.get(worktreeId) !== snapshot) {
        changedWorktreeIds.add(worktreeId)
      }
    }
    return changedWorktreeIds
  }
}
