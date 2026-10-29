import { OrcaRuntimeWithAttachWindow } from './session-graph-promotion'
import type {
  RuntimeRendererSyncWindowGraph,
  RuntimeSyncedTab,
  RuntimeSyncWindowGraph,
  RuntimeSyncWindowGraphResult
} from '../../../shared/runtime-session-contracts'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-types'
import type { RuntimeLeafRecord } from '../runtime-terminal-state-records'

import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'

type Graph = RuntimeSyncWindowGraph

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

export abstract class OrcaRuntimeWithSyncWindowGraph extends OrcaRuntimeWithAttachWindow {
  /** Layout-owner builds: main's panes in place of the window's (session-tabs-inventory.ts). */
  protected abstract withMainSurfaces(windowId: number, graph: Graph): Graph
  declare protected terminalGroupGridSizes?: RuntimeSyncWindowGraph['terminalGroupGridSizes']
  declare protected singleGroupWorkspaceGridSize?: RuntimeSyncWindowGraph['singleGroupWorkspaceGridSize']

  // Remounts briefly clear ptyId; retain the live handle paired clients still use (#23759).
  private isLeafRemountingLivePty(
    ptyId: string,
    incomingPtyIds: ReadonlySet<string | null>
  ): boolean {
    return (
      !incomingPtyIds.has(ptyId) &&
      this.controllerKnowsPtyIsLive(ptyId) &&
      this.getPtyLivenessVerdict(ptyId)?.status !== 'exited'
    )
  }

  shouldRelayTerminalBrowserOpens(): boolean {
    return this.authoritativeWindowId === HEADLESS_RUNTIME_WINDOW_ID
  }

  syncWindowGraph(
    windowId: number,
    graph: RuntimeSyncWindowGraph | RuntimeRendererSyncWindowGraph
  ): RuntimeSyncWindowGraphResult {
    // Reject duplicate bare tab ids before mutating authority/state or indexes could route PTYs to the wrong worktree.
    assertUniqueRuntimeGraphTabIds(graph.tabs)
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
    if (windowId === HEADLESS_RUNTIME_WINDOW_ID) {
      this.headlessGraphFallbackAvailable = true
      this.servesHeadlessGraph = true
      this.rendererGeneration = null
    }
    graph = ORCA_LAYOUT_OWNER_IS_MAIN ? this.withMainSurfaces(windowId, graph) : graph

    if (graph.terminalGroupGridSizes) {
      // Merged, not replaced: a group in a worktree the window is not showing keeps its last size.
      this.terminalGroupGridSizes = {
        ...this.terminalGroupGridSizes,
        ...graph.terminalGroupGridSizes
      }
    }
    if (graph.singleGroupWorkspaceGridSize) {
      this.singleGroupWorkspaceGridSize = graph.singleGroupWorkspaceGridSize
    }
    this.activeGroupViewFacts.merge(graph.activeGroupByWorkspace)
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
    // Stamp this graph's surfaces; newer records survive until the next statement (pty-recorded-surface-topology.ts).
    // Exempt the one-shot headless placeholder: it names no renderer panes and cannot re-stamp later claims (#18191).
    if (windowId !== HEADLESS_RUNTIME_WINDOW_ID) {
      this.graphSequence += 1
    }

    // Preserve live CLI handles while reload briefly publishes leaves without PTYs.
    const preserveLivePtysDuringReload = this.graphStatus === 'reloading'
    const incomingPtyIds = new Set(lifecycleLeaves.map((leaf) => leaf.ptyId).filter(Boolean))
    for (const leaf of lifecycleLeaves) {
      if (leaf.ptyId) {
        if (leaf.parked) {
          this.orchestrationMailboxPointerDelivery.markPtyColdParked(leaf.ptyId)
        } else {
          this.orchestrationMailboxPointerDelivery.clearPtyColdParked(leaf.ptyId)
        }
      }
      const leafKey = this.getLeafKey(leaf.tabId, leaf.leafId)
      const existing = this.leaves.get(leafKey)
      const ptyId =
        leaf.ptyId === null &&
        existing?.ptyId &&
        (preserveLivePtysDuringReload ||
          this.isLeafRemountingLivePty(existing.ptyId, incomingPtyIds))
          ? existing.ptyId
          : leaf.ptyId
      const ptyGeneration =
        existing && existing.ptyId !== ptyId
          ? existing.ptyGeneration + 1
          : (existing?.ptyGeneration ?? 0)
      const existingPty = ptyId ? this.ptysById.get(ptyId) : undefined
      // Retained history stays addressable; whether the terminal runs is graphLeafConnected's call.
      const connected = this.graphLeafConnected(ptyId, leaf.worktreeId)
      const tailSource = existing?.ptyId === ptyId ? existing : existingPty

      nextLeaves.set(leafKey, {
        ...leaf,
        ptyId,
        ptyGeneration,
        connected,
        writable: this.graphStatus === 'ready' && connected,
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

      // Main-owned pane presence does not prove its terminal is connected.
      if (leaf.ptyId && connected && !this.mainDecidesLiveness(leaf.worktreeId)) {
        this.recordPtyWorktree(leaf.ptyId, leaf.worktreeId, {
          connected: true,
          lastOutputAt: existing?.ptyId === leaf.ptyId ? existing.lastOutputAt : null,
          preview: existing?.ptyId === leaf.ptyId ? existing.preview : '',
          tabId: leaf.tabId,
          paneKey: this.makeRuntimePaneKey(leaf),
          surfaceRecordedAtGraphSequence: this.graphSequence
        })
      }

      if (existing && (existing.ptyId !== ptyId || existing.ptyGeneration !== ptyGeneration)) {
        // Adopt the first PTY into the pending handle mobile already subscribed to.
        const adoptedFirstPty =
          existing.ptyId === null && this.adoptFirstPtyForLeafHandle(leafKey, ptyId, ptyGeneration)
        if (!adoptedFirstPty) {
          this.invalidateLeafHandle(leafKey)
        }
      }
    }

    // Compute before stale-leaf preservation so a rebound PTY cannot acquire duplicate handles/React keys.
    const nextPtyIds = new Set(
      [...nextLeaves.values()].map((leaf) => leaf.ptyId).filter((ptyId): ptyId is string => !!ptyId)
    )
    for (const oldLeafKey of this.leaves.keys()) {
      if (!nextLeaves.has(oldLeafKey)) {
        const oldLeaf = this.leaves.get(oldLeafKey)
        if (oldLeaf?.ptyId && !nextPtyIds.has(oldLeaf.ptyId)) {
          // A cold-parked PTY remains alive without a graph leaf; hold its
          // staged Enter until a live idle frame authorizes submission.
          this.orchestrationMailboxPointerDelivery.markPtyColdParked(oldLeaf.ptyId)
        }
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
          // CLI agents retain their exported handles while the reloaded renderer rebinds panes.
          nextLeaves.set(oldLeafKey, oldLeaf)
          nextPtyIds.add(oldLeaf.ptyId)
        } else if (oldLeaf?.ptyId && nextPtyIds.has(oldLeaf.ptyId)) {
          // The new live leaf owns this PTY; drop the stale alias to avoid duplicate handles/React keys.
          // Preserve any shared PTY handle; invalidate leaf-unique handles so old waiters fail instead of hanging.
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
    this.followExportedPaneKeys()
    this.reconcilePtyIncarnationHandles()
    // Graph-only changes affect mobile handles/titles/liveness too; fan out the union on the same 50ms trailing edge, reading latest state at emission.
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
      // Clients discard same-epoch non-increasing versions; bump graph-only changes locally without changing accepted-renderer tracking.
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
        this.checkDeliverySettledAndArmRecheck(leaf) &&
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

    // createTerminal waits for graph sync; drain callbacks only after updating leaves.
    for (const cb of Array.from(this.graphSyncCallbacks)) {
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
