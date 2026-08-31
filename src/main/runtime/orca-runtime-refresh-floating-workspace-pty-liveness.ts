// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithRefreshPtyWorktreeRecordsWithControllerInventory } from './orca-runtime-refresh-pty-worktree-records-with-controller-inventory'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { isTerminalLeafId, makePaneKey } from '../../shared/stable-pane-id'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { DISCONNECTED_PTY_RECORD_MAX } from './orca-runtime-postlude'

export class OrcaRuntimeWithRefreshFloatingWorkspacePtyLiveness extends OrcaRuntimeWithRefreshPtyWorktreeRecordsWithControllerInventory {
  protected refreshFloatingWorkspacePtyLiveness(): Set<string> | null {
    const controller = this.ptyController
    if (!controller?.hasPty) {
      return null
    }
    const knownPtyIds = new Set<string>()
    const persistedBindingByPtyId = new Map<string, { tabId: string; paneKey: string }>()
    for (const pty of this.ptysById.values()) {
      if (pty.worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
        knownPtyIds.add(pty.ptyId)
      }
    }
    for (const leaf of this.leaves.values()) {
      if (leaf.worktreeId === FLOATING_TERMINAL_WORKTREE_ID && leaf.ptyId) {
        knownPtyIds.add(leaf.ptyId)
      }
    }
    const snapshot = this.mobileSessionTabsByWorktree.get(FLOATING_TERMINAL_WORKTREE_ID)
    for (const tab of snapshot?.tabs ?? []) {
      if (tab.type !== 'terminal') {
        continue
      }
      if (tab.ptyId) {
        knownPtyIds.add(tab.ptyId)
        persistedBindingByPtyId.set(tab.ptyId, {
          tabId: tab.parentTabId,
          paneKey: this.getMobileTerminalPaneKey(tab)
        })
      }
      for (const [leafId, ptyId] of Object.entries(tab.parentLayout?.ptyIdsByLeafId ?? {})) {
        knownPtyIds.add(ptyId)
        persistedBindingByPtyId.set(ptyId, {
          tabId: tab.parentTabId,
          paneKey: isTerminalLeafId(leafId)
            ? makePaneKey(tab.parentTabId, leafId)
            : `${tab.parentTabId}:${/^pane:(\d+)$/.exec(leafId)?.[1] ?? leafId}`
        })
      }
    }

    const liveness = new Map<string, boolean>()
    try {
      for (const ptyId of knownPtyIds) {
        const live = controller.hasPty(ptyId)
        if (live === null) {
          return null
        }
        liveness.set(ptyId, live)
      }
    } catch {
      return null
    }

    const livePtyIds = new Set<string>()
    for (const [ptyId, live] of liveness) {
      let pty = this.ptysById.get(ptyId)
      if (live) {
        livePtyIds.add(ptyId)
        const binding = persistedBindingByPtyId.get(ptyId)
        if (!pty && binding) {
          // Why: a live daemon PTY restored from disk needs its pane identity before mobile can issue a safe handle.
          pty = this.recordPtyWorktree(ptyId, FLOATING_TERMINAL_WORKTREE_ID, {
            connected: true,
            tabId: binding.tabId,
            paneKey: binding.paneKey
          })
        }
        if (pty) {
          pty.connected = true
          pty.disconnectedAt = null
          this.forgetPtyLivenessVerdict(ptyId)
          this.refreshPtyForegroundAgent(ptyId)
        }
      } else if (pty && !this.leafExistsForPty(ptyId)) {
        pty.connected = false
        pty.disconnectedAt ??= Date.now()
      }
    }
    this.pruneDisconnectedPtyRecords()
    return livePtyIds
  }

  protected pruneDisconnectedPtyTranscript(pty: RuntimePtyWorktreeRecord): void {
    if (pty.connected) {
      return
    }
    // Why: disconnected PTY records stay addressable for status/exit reads, but their transcripts must not accumulate after the process dies.
    pty.tailBuffer = []
    pty.tailTranscriptBuffer = []
    pty.tailTranscriptChars = 0
    pty.tailPartialLine = ''
    pty.tailPendingAnsi = ''
    pty.tailRedrawCursor = null
    pty.tailTruncated = false
    pty.tailLinesTotal = 0
    pty.waitBlockedAt = null
    // Why: tail is now empty, so clear the memoized wait scan; onPtyData must recompute from the reset tail if this record resumes output.
    pty.tailWaitState = undefined
  }

  protected pruneDisconnectedPtyRecords(): void {
    const retained = [...this.ptysById.values()]
      .filter((pty) => !pty.connected && !this.leafExistsForPty(pty.ptyId))
      .sort((a, b) => (a.disconnectedAt ?? 0) - (b.disconnectedAt ?? 0))
    const staleCount = Math.max(0, retained.length - DISCONNECTED_PTY_RECORD_MAX)
    for (const stale of retained.slice(0, staleCount)) {
      // Why: exited runtime-owned PTYs stay readable, but long-lived runtimes churn through many sessions; bound the archive.
      this.dropDisconnectedPtyRecord(stale.ptyId)
    }
  }

  protected dropDisconnectedPtyRecord(ptyId: string): void {
    // Why: pruning can remove a PTY without the normal exit callback.
    this.advancePtyLifecycleGeneration(ptyId)
    this.pairedRendererSessionOwnedPtyIds.delete(ptyId)
    this.ptysById.delete(ptyId)
    this.pendingPtyHandleReplacementFences.delete(ptyId)
    this.recentPtyOutputById.delete(ptyId)
    this.setupCompletionTokenByPtyId.delete(ptyId)
    this.clearWaitBlockedCheckState(ptyId)
    this.recentPtyPathCandidatesById.delete(ptyId)
    this.ptyOutputSequenceById.delete(ptyId)
    this.providerSequenceInitializedPtys.delete(ptyId)
    this.providerSequenceOffsetByPtyId.delete(ptyId)
    this.providerSnapshotPreferredPtys.delete(ptyId)
    this.providerModeTrackersByPtyId.delete(ptyId)
    this.providerModeSnapshotScansByPtyId.delete(ptyId)
    this.providerBufferAcquisitionsByPtyId.delete(ptyId)
    this.providerVisibleStateByPtyId.delete(ptyId)
    this.providerVisibleRetryAtByPtyId.delete(ptyId)
    this.agentStatusOscProcessorsByPtyId.delete(ptyId)
    this.ompPromptReadinessByPtyId.delete(ptyId)
    this.terminalSpawnCommandsByPtyId.delete(ptyId)
    this.disposePtyTitleTracker(ptyId)
    this.invalidatePtyIncarnationHandle(ptyId)
    this.oscTitleScanTailByPtyId.delete(ptyId)
    this.osc7ScanTailByPtyId.delete(ptyId)
    this.terminalCwdByPtyId.delete(ptyId)
    this.terminalFileUriHostnameByPtyId.delete(ptyId)
    this.wslDistroByPtyId.delete(ptyId)
    this.clearAgentRowSnapshotsForPty(ptyId)
    const handle = this.handleByPtyId.get(ptyId)
    if (handle) {
      // Why: pruning can remove a PTY without onPtyExit firing; release this leader's agent team so it doesn't leak.
      this.claudeAgentTeams.removeTeamForLeaderHandle(handle)
      this.handleByPtyId.delete(ptyId)
      this.syntheticTerminalHandles.delete(handle)
      const record = this.handles.get(handle)
      if (record?.tabId.startsWith('pty:')) {
        this.handles.delete(handle)
      }
    }
  }

  protected leafExistsForPty(ptyId: string): boolean {
    return (this.leavesByPtyId.get(ptyId)?.length ?? 0) > 0
  }

  protected rebuildLeafPtyIndex(): void {
    const next = new Map<string, RuntimeLeafRecord[]>()
    for (const leaf of this.leaves.values()) {
      if (!leaf.ptyId) {
        continue
      }
      const leaves = next.get(leaf.ptyId)
      if (leaves) {
        leaves.push(leaf)
      } else {
        next.set(leaf.ptyId, [leaf])
      }
    }
    this.leavesByPtyId = next
  }

  protected getLeavesForPty(ptyId: string): RuntimeLeafRecord[] {
    return this.leavesByPtyId.get(ptyId) ?? []
  }

  // Keep the notification hook on the runtime as well as on the installed
  // command surface: exit escalation can wake an in-flight --wait directly.
  notifyMessageArrived(handle: string, messageType?: string): void {
    if (!handle.startsWith('dispatch:')) {
      this.mailPointerRepointScheduler.schedule(handle)
    }
    this.orchestrationMailboxNotifications.notifyMessageArrived(handle, messageType)
  }
}
