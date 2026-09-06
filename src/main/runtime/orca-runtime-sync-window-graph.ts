/* eslint-disable unicorn/no-useless-spread */
// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithAttachWindow } from './orca-runtime-attach-window'
import type {
  RuntimeRendererSyncWindowGraph,
  RuntimeSyncedTab,
  RuntimeSyncWindowGraph,
  RuntimeSyncWindowGraphResult
} from '../../shared/runtime-types'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import type { RuntimeLeafRecord } from './runtime-terminal-state-records'

/** The runtime indexes graph tabs by bare id, so duplicate ids cannot be routed safely. */
function assertUniqueRuntimeGraphTabIds(tabs: readonly RuntimeSyncedTab[]): void {
  const seen = new Set<string>()
  for (const tab of tabs) {
    if (seen.has(tab.tabId)) {
      throw new Error('duplicate_runtime_tab_id')
    }
    seen.add(tab.tabId)
  }
}

export class OrcaRuntimeWithSyncWindowGraph extends OrcaRuntimeWithAttachWindow {
  shouldRelayTerminalBrowserOpens(): boolean {
    return this.authoritativeWindowId === HEADLESS_RUNTIME_WINDOW_ID
  }

  syncWindowGraph(
    windowId: number,
    graph: RuntimeSyncWindowGraph | RuntimeRendererSyncWindowGraph
  ): RuntimeSyncWindowGraphResult {
    // `tabs` and several downstream indexes are keyed only by tab id. Reject
    // malformed persisted/mirrored graphs before authority or graph state is
    // changed; choosing a winner would route PTYs to the wrong worktree.
    assertUniqueRuntimeGraphTabIds(graph.tabs)
    if (
      windowId !== HEADLESS_RUNTIME_WINDOW_ID &&
      this.authoritativeWindowId === HEADLESS_RUNTIME_WINDOW_ID &&
      this.headlessGraphFallbackAvailable
    ) {
      if (windowId !== this.pendingHeadlessPromotionWindowId) {
        throw new Error('Runtime graph publisher does not match the pending desktop promotion')
      }
      // Why: a renderer may publish after a failed promotion was restored to
      // headless authority; accepting that late healthy graph is self-healing.
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
    if (windowId === HEADLESS_RUNTIME_WINDOW_ID) {
      this.headlessGraphFallbackAvailable = true
      this.rendererGeneration = null
    }

    const graphWasReady = this.graphStatus === 'ready'
    const previousTabs = this.tabs
    const previousLeaves = this.leaves
    this.tabs = new Map(graph.tabs.map((tab) => [tab.tabId, tab]))
    const lifecycleLeaves = this.reconcileMobileSessionRetirementFences(graph.leaves)
    const mobileSessionResyncWorktrees = new Set<string>()
    const changedMobileWorktrees = this.syncMobileSessionTabs(
      graph.mobileSessionTabs,
      graph.unchangedMobileSessionWorktrees,
      mobileSessionResyncWorktrees,
      rendererGeneration
    )
    const nextLeaves = new Map<string, RuntimeLeafRecord>()
    const graphSyncedAt = this.nextTitleObservationSequence()

    // Why: renderer reloads can briefly republish the same leaf with no ptyId;
    // keep live CLI handles usable while the UI graph rebuilds.
    const preserveLivePtysDuringReload = this.graphStatus === 'reloading'
    for (const leaf of lifecycleLeaves) {
      const leafKey = this.getLeafKey(leaf.tabId, leaf.leafId)
      const existing = this.leaves.get(leafKey)
      const ptyId =
        preserveLivePtysDuringReload && leaf.ptyId === null && existing?.ptyId
          ? existing.ptyId
          : leaf.ptyId
      const ptyGeneration =
        existing && existing.ptyId !== ptyId
          ? existing.ptyGeneration + 1
          : (existing?.ptyGeneration ?? 0)
      const existingPty = ptyId ? this.ptysById.get(ptyId) : undefined
      const tailSource = existing?.ptyId === ptyId ? existing : existingPty

      nextLeaves.set(leafKey, {
        ...leaf,
        ptyId,
        ptyGeneration,
        connected: ptyId !== null,
        writable: this.graphStatus === 'ready' && ptyId !== null,
        lastOutputAt: tailSource?.lastOutputAt ?? null,
        lastExitCode: tailSource?.lastExitCode ?? null,
        lastExitCause: tailSource?.lastExitCause ?? null,
        tailBuffer: tailSource?.tailBuffer ?? [],
        tailTranscriptBuffer: tailSource?.tailTranscriptBuffer ?? [],
        tailTranscriptChars: tailSource?.tailTranscriptChars ?? 0,
        tailPartialLine: tailSource?.tailPartialLine ?? '',
        tailPendingAnsi: tailSource?.tailPendingAnsi ?? '',
        tailRedrawCursor: tailSource?.tailRedrawCursor ?? null,
        tailTruncated: tailSource?.tailTruncated ?? false,
        tailLinesTotal: tailSource?.tailLinesTotal ?? 0,
        preview: tailSource?.preview ?? '',
        waitBlockedAt: tailSource?.waitBlockedAt ?? null,
        lastAgentStatus: tailSource?.lastAgentStatus ?? null,
        lastAgentStatusObservedLive: tailSource?.lastAgentStatusObservedLive ?? false,
        lastOscTitle: tailSource?.lastOscTitle ?? null,
        lastOscTitleAt: tailSource?.lastOscTitleAt ?? null,
        paneTitleUpdatedAt:
          existing?.ptyId === ptyId && existing.paneTitle === leaf.paneTitle
            ? existing.paneTitleUpdatedAt
            : graphSyncedAt
      })

      if (leaf.ptyId) {
        this.recordPtyWorktree(leaf.ptyId, leaf.worktreeId, {
          connected: true,
          lastOutputAt: existing?.ptyId === leaf.ptyId ? existing.lastOutputAt : null,
          preview: existing?.ptyId === leaf.ptyId ? existing.preview : '',
          tabId: leaf.tabId,
          paneKey: this.makeRuntimePaneKey(leaf)
        })
      }

      if (existing && (existing.ptyId !== ptyId || existing.ptyGeneration !== ptyGeneration)) {
        // Why: mobile can subscribe while the pane is waiting for its first PTY.
        // Keep that handle usable after the recovery mount binds it.
        const adoptedFirstPty =
          existing.ptyId === null && this.adoptFirstPtyForLeafHandle(leafKey, ptyId, ptyGeneration)
        if (!adoptedFirstPty) {
          this.invalidateLeafHandle(leafKey)
        }
      }
    }

    // Why: computed BEFORE preserving stale leaves so preservation can refuse a
    // leaf whose PTY the incoming graph already rebound to a live leaf. Two
    // leaves on one PTY resolve to the same handle (handles are ptyId-keyed) and
    // crash paired clients with a duplicate React key.
    const nextPtyIds = new Set(
      [...nextLeaves.values()].map((leaf) => leaf.ptyId).filter((ptyId): ptyId is string => !!ptyId)
    )
    for (const oldLeafKey of this.leaves.keys()) {
      if (!nextLeaves.has(oldLeafKey)) {
        const oldLeaf = this.leaves.get(oldLeafKey)
        const retainedIncarnation = oldLeaf?.ptyId
          ? this.handleByPtyIncarnation.get(oldLeaf.ptyId)
          : undefined
        if (
          preserveLivePtysDuringReload &&
          oldLeaf?.ptyId &&
          (this.handleByPtyId.has(oldLeaf.ptyId) ||
            (retainedIncarnation &&
              retainedIncarnation.incarnationId ===
                this.ptysById.get(oldLeaf.ptyId)?.incarnationId)) &&
          !nextPtyIds.has(oldLeaf.ptyId)
        ) {
          // Why: a CLI-created agent keeps using its exported handle even if
          // the reloaded renderer has not rebound the pane yet.
          nextLeaves.set(oldLeafKey, oldLeaf)
          nextPtyIds.add(oldLeaf.ptyId)
        } else if (oldLeaf?.ptyId && nextPtyIds.has(oldLeaf.ptyId)) {
          // Why: the incoming graph already rebound this PTY to a live leaf (e.g.
          // a woken agent re-keyed to a new leaf during renderer reload). Keeping
          // the old leaf too would put two leaves on ONE PTY, which emit the same
          // terminal handle and crash paired clients. Drop the stale leaf; if its
          // handle is the shared ptyId-keyed one it belongs to the live leaf now,
          // so release only this dead leaf key's alias. A leaf-unique handle has
          // no next owner — invalidate it so in-flight CLI waiters fail fast
          // instead of hanging on a dead leaf.
          const oldHandle = this.handleByLeafKey.get(oldLeafKey)
          const incarnationHandle = retainedIncarnation?.handle
          if (
            oldHandle !== undefined &&
            (oldHandle === this.handleByPtyId.get(oldLeaf.ptyId) || oldHandle === incarnationHandle)
          ) {
            this.handleByLeafKey.delete(oldLeafKey)
          } else {
            this.invalidateLeafHandle(oldLeafKey)
          }
        } else {
          this.invalidateLeafHandle(oldLeafKey)
        }
      }
    }

    for (const [ptyId, leaf] of this.detachedPreAllocatedLeaves) {
      if (nextPtyIds.has(ptyId) || !this.handleByPtyId.has(ptyId)) {
        this.detachedPreAllocatedLeaves.delete(ptyId)
        continue
      }
      nextLeaves.set(this.getLeafKey(leaf.tabId, leaf.leafId), leaf)
      nextPtyIds.add(ptyId)
    }

    this.leaves = nextLeaves
    this.rebuildLeafPtyIndex()
    this.reconcilePtyIncarnationHandles()
    // Why: the emitted client payload is a function of the stored snapshot AND
    // the tab/leaf graph (handles/titles/connected resolve from leaf state), so
    // a graph-only change — e.g. a restored leaf binding its ptyId while the
    // snapshot pair is unchanged — must also fan out, or a paired client stays
    // on pending-handle forever. Schedule the union on the same 50ms trailing
    // edge as the OSC-title path; the coalescer emit reads the latest state at
    // fire time so no final version is ever lost.
    for (const worktreeId of this.collectMobileVisibleGraphChangedWorktrees(
      previousTabs,
      previousLeaves
    )) {
      if (changedMobileWorktrees.has(worktreeId)) {
        continue
      }
      const stored = this.mobileSessionTabsByWorktree.get(worktreeId)
      if (!stored) {
        continue
      }
      // Why: web clients drop same-epoch frames whose version isn't strictly
      // newer, so a graph-only change must mint a fresh stored version (like
      // the PTY touch path does) or the re-emitted payload — e.g. the
      // pending-handle → ready flip — is discarded and the client stays stale.
      // The accepted-renderer tracking is untouched: this is a main-local bump.
      this.storeMobileSessionSnapshot(worktreeId, {
        ...stored,
        snapshotVersion: stored.snapshotVersion + 1
      })
      changedMobileWorktrees.add(worktreeId)
    }
    for (const worktreeId of changedMobileWorktrees) {
      if (this.mobileSessionTabsByWorktree.has(worktreeId)) {
        this.scheduleMobileSessionTabsChanged(worktreeId)
      }
    }
    const isAuthoritativeGraphPublisher = windowId === this.authoritativeWindowId
    this.markGraphReady(windowId)
    if (
      isAuthoritativeGraphPublisher &&
      (windowId === HEADLESS_RUNTIME_WINDOW_ID || graph.mobileSessionTabs !== undefined)
    ) {
      if (mobileSessionResyncWorktrees.size === 0) {
        this.markSessionTabsInventoryPublished()
      } else {
        this.sessionTabsInventoryPublicationEpoch = null
      }
    }
    if (rendererGeneration !== undefined) {
      this.rendererGeneration = rendererGeneration
    }
    for (const leaf of this.leaves.values()) {
      this.adoptPreAllocatedHandle(leaf)
      const previousLeaf = previousLeaves.get(this.getLeafKey(leaf.tabId, leaf.leafId))
      if (
        this._orchestrationDb &&
        leaf.lastAgentStatus === 'idle' &&
        leaf.lastAgentStatusObservedLive &&
        leaf.writable &&
        (!graphWasReady ||
          previousLeaf?.ptyId !== leaf.ptyId ||
          !previousLeaf.writable ||
          previousLeaf.lastAgentStatus !== 'idle' ||
          !previousLeaf.lastAgentStatusObservedLive)
      ) {
        this.deliverPendingMessagesForLeaf(leaf)
      }
    }

    // Why: createTerminal waits for the renderer's graph sync to populate the
    // new leaf so it can return a handle. Drain callbacks after leaves update.
    for (const cb of [...this.graphSyncCallbacks]) {
      cb()
    }

    const agentOrchestrationByPaneKey = this.agentOrchestrationProjection.buildByPaneKey()
    const nativeChatLaunchDraftResolutions =
      this.getNativeChatLaunchDraftResolutionClientEventSnapshot().map(
        ({ tabId, text, createdAt }) => ({ tabId, text, createdAt })
      )
    return {
      ...this.getStatus(),
      ...(agentOrchestrationByPaneKey ? { agentOrchestrationByPaneKey } : {}),
      ...(nativeChatLaunchDraftResolutions.length > 0 ? { nativeChatLaunchDraftResolutions } : {}),
      ...(mobileSessionResyncWorktrees.size > 0
        ? { mobileSessionResyncWorktrees: [...mobileSessionResyncWorktrees] }
        : {})
    }
  }
}
