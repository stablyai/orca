import { rendererStatusReplica, type RendererStatusMember } from './renderer-status-replica'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import type {
  RendererStatusPublication,
  RendererStatusAck
} from '../../../shared/agent-status/renderer-status-publication'
import { OrcaRuntimeWithAttachWindow } from './session-graph-promotion'
import type {
  RuntimeRendererSyncWindowGraph,
  RuntimeSyncWindowGraph
} from '../../../shared/runtime-session-contracts'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-session-contracts'

export abstract class OrcaRuntimeWithAdmitWindowPublisher extends OrcaRuntimeWithAttachWindow {
  syncRendererAgentStatus(windowId: number, batch: RendererStatusPublication): RendererStatusAck {
    if (
      windowId !== this.authoritativeWindowId ||
      this.rendererGeneration !== batch.epoch ||
      this.graphStatus !== 'ready'
    ) {
      return { accepted: false }
    }
    const { worktrees, ...ack } = rendererStatusReplica(this).apply(batch)
    for (const worktreeId of worktrees) {
      const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
      if (!snapshot) {
        continue
      }
      // Status changes invalidate only this phone frame; graph hydration and activity stay idle.
      this.mobileSessionTabsByWorktree.set(worktreeId, {
        ...snapshot,
        snapshotVersion: snapshot.snapshotVersion + 1
      })
      this.scheduleMobileSessionTabsChanged(worktreeId)
    }
    return ack
  }

  protected reconcileRendererStatusMembership(
    rendererGeneration: string,
    graph: RuntimeSyncWindowGraph,
    changedMobileWorktrees: Set<string>
  ): void {
    const replica = rendererStatusReplica(this)
    replica.beginEpoch(rendererGeneration)
    const members = new Map<string, RendererStatusMember>()
    const unchanged = new Set(graph.unchangedMobileSessionWorktrees ?? [])
    const rawBindings = new Map(
      graph.leaves.map((leaf) => [makePaneKey(leaf.tabId, leaf.leafId), leaf.ptyId])
    )
    for (const snapshot of graph.mobileSessionTabs ?? []) {
      const accepted = this.acceptedRendererMobileSnapshotByWorktree.get(snapshot.worktree)
      if (
        !accepted ||
        accepted.publicationEpoch !== snapshot.publicationEpoch ||
        accepted.rendererVersion !== snapshot.snapshotVersion
      ) {
        if (accepted) {
          unchanged.add(snapshot.worktree)
        }
        continue
      }
      const storedIds = new Set(
        this.mobileSessionTabsByWorktree.get(snapshot.worktree)?.tabs.map((tab) => tab.id)
      )
      for (const tab of snapshot.tabs) {
        if (tab.type !== 'terminal' || !storedIds.has(tab.id)) {
          continue
        }
        const paneKey = makePaneKey(tab.parentTabId, tab.leafId)
        members.set(paneKey, {
          paneKey,
          leafId: tab.leafId,
          worktreeId: snapshot.worktree,
          rendererPtyId: rawBindings.has(paneKey) ? rawBindings.get(paneKey)! : (tab.ptyId ?? null),
          statusSuppressionTitle: tab.statusSuppressionTitle ?? ''
        })
      }
    }
    for (const worktreeId of replica.reconcileGraph(members, unchanged)) {
      if (!changedMobileWorktrees.has(worktreeId)) {
        const stored = this.mobileSessionTabsByWorktree.get(worktreeId)
        if (stored) {
          this.mobileSessionTabsByWorktree.set(worktreeId, {
            ...stored,
            snapshotVersion: stored.snapshotVersion + 1
          })
        }
      }
      changedMobileWorktrees.add(worktreeId)
    }
  }

  protected admitWindowPublisher(
    windowId: number,
    graph: RuntimeSyncWindowGraph | RuntimeRendererSyncWindowGraph
  ): string | null | undefined {
    if (
      windowId !== HEADLESS_RUNTIME_WINDOW_ID &&
      this.authoritativeWindowId === HEADLESS_RUNTIME_WINDOW_ID &&
      this.headlessGraphFallbackAvailable
    ) {
      if (windowId !== this.pendingHeadlessPromotionWindowId) {
        throw new Error('Runtime graph publisher does not match the pending desktop promotion')
      }
      // Accept late healthy graphs after failed promotion restores headless authority.
      this.attachWindow(windowId)
    }
    if (this.authoritativeWindowId === null) {
      this.authoritativeWindowId = windowId
    }
    if (windowId !== this.authoritativeWindowId) {
      throw new Error('Runtime graph publisher does not match the authoritative window')
    }
    const rendererGeneration =
      windowId === HEADLESS_RUNTIME_WINDOW_ID
        ? null
        : 'rendererGeneration' in graph && typeof graph.rendererGeneration === 'string'
          ? graph.rendererGeneration
          : undefined
    if (
      typeof rendererGeneration === 'string' &&
      rendererGeneration === this.rendererGeneration &&
      this.graphStatus !== 'ready'
    ) {
      throw new Error('Runtime graph publisher belongs to a superseded renderer generation')
    }
    return rendererGeneration
  }
}
