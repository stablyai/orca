/* eslint-disable unicorn/no-useless-spread */
// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithWriteOrchestrationPointerPty } from './orca-runtime-write-orchestration-pointer-pty'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getMobileSessionSnapshotTabIdentityKeys } from './mobile-session-tab-merge'

export class OrcaRuntimeWithSyncMobileSessionTabs extends OrcaRuntimeWithWriteOrchestrationPointerPty {
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
    // Why: snapshots are immutable — every writer replaces the map entry with a
    // new object, and the accept gate below drops semantically-unchanged
    // renderer resends before they replace an entry — so reference identity
    // before/after detects exactly the entries that actually changed.
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
        // Why: every catalog row carries an instanceId, so a mismatch against the
        // live meta is exactly "not the current occupant" — no removed-id memory needed.
        if (snapshot.worktreeInstanceId !== currentMeta.instanceId) {
          return reject()
        }
        // Why: the successor's identity proves the race window closed; the
        // instanceId mismatch alone fences any later frame from the old occupant.
        this.removedMobileSessionWorktreeIds.delete(snapshot.worktree)
        return true
      }
      // Identity-less frame: only the live renderer generation can speak for the
      // successor, and the generation that published the removed occupant never
      // can — a same-generation recreate stays fenced until the renderer reloads.
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
    // Why: graph sync must scan each persisted host session once, not once per workspace.
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
    // Why: an empty renderer publication after HUB restart must not hide SSH panes persisted in this HUB's host partition.
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
    // Why: the renderer withholds unchanged snapshots to keep the graph payload
    // small, so these worktrees are still live and must not fall into the prune
    // below. Ask for a republish when main no longer holds that accepted renderer
    // publication or a formerly-preserved runtime tab has gone stale.
    for (const worktreeId of unchangedWorktreeIds ?? []) {
      const existing = this.mobileSessionTabsByWorktree.get(worktreeId)
      const accepted = this.acceptedRendererMobileSnapshotByWorktree.get(worktreeId)
      if (existing) {
        nextWorktrees.add(worktreeId)
      }
      // Why: a fenced frame stays "published" renderer-side; asking for a
      // republish would only be fenced again on every sync.
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
      // Why: the accept gate compares against the renderer's last accepted pair,
      // which outlives the dropped snapshot and would reject the republish.
      this.acceptedRendererMobileSnapshotByWorktree.delete(worktreeId)
    }
    for (const snapshot of acceptedSnapshots) {
      nextWorktrees.add(snapshot.worktree)
      const existing = this.mobileSessionTabsByWorktree.get(snapshot.worktree)
      // Why: judge renderer publication ordering against the renderer's own
      // last-accepted (epoch, version) — the renderer reuses one pair for
      // byte-identical content, so a same-epoch version <= the accepted one is
      // a no-op resend (or a stale frame) and must be skipped. Never compare
      // against the stored snapshot's version: main-local touches bump it
      // independently and would reject genuinely newer renderer revisions.
      const accepted = this.acceptedRendererMobileSnapshotByWorktree.get(snapshot.worktree)
      if (
        accepted &&
        accepted.publicationEpoch === snapshot.publicationEpoch &&
        snapshot.snapshotVersion <= accepted.rendererVersion &&
        // Why: preservation is main-only state — a serve/SSH binding (or live
        // browser page) can disappear without the renderer bumping its version,
        // so a resend of the EXACT accepted revision (content-identical to the
        // accepted publication, safe to re-merge) must still fall through to
        // the merge, which prunes stale preserved tabs. Strictly-older frames
        // stay skipped: their content is outdated, and the next accepted-pair
        // resend performs the prune.
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
      // Why: clients drop same-epoch frames whose version isn't strictly newer,
      // and main-local touches may already have emitted a higher version than
      // the renderer's counter — keep the stored version strictly monotonic so
      // the accepted content is never discarded as stale downstream.
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
    for (const [worktreeId, existing] of [...this.mobileSessionTabsByWorktree.entries()]) {
      if (!nextWorktrees.has(worktreeId)) {
        const preserved = this.buildPreservedHeadlessMobileSessionSnapshot(existing)
        if (preserved) {
          // Why: preservation filters existing.tabs in place (same objects) and
          // the merge epoch hashes the preserved identities idempotently, so an
          // equal epoch with every tab object retained means the recomputation
          // was a no-op — keep the entry so no-op syncs don't fan out.
          const preservedIsNoOp =
            preserved.publicationEpoch === existing.publicationEpoch &&
            preserved.tabs.length === existing.tabs.length &&
            preserved.tabs.every((tab, index) => tab === existing.tabs[index])
          if (!preservedIsNoOp) {
            this.storeMobileSessionSnapshot(worktreeId, preserved)
          }
          // Why: the stored entry is no longer the renderer's publication, so a
          // future renderer frame must be re-merged even if it reuses the pair.
          this.acceptedRendererMobileSnapshotByWorktree.delete(worktreeId)
          nextWorktrees.add(worktreeId)
        } else {
          this.mobileSessionTabsByWorktree.delete(worktreeId)
          this.mobileSessionTabsAgentStatusHeartbeat.removeWorktree(worktreeId)
          this.acceptedRendererMobileSnapshotByWorktree.delete(worktreeId)
          // Why: drop any pending coalesced notify so a stale snapshot can't land after the removed frame.
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
