import { OrcaRuntimeWithRefreshPtyWorktreeRecordsWithControllerInventory } from './pty-controller-inventory-refresh'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { indexFloatingSnapshotPtyBindings } from '../../floating-snapshot-pty-bindings'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'
import { DISCONNECTED_PTY_RECORD_MAX } from '../../orca-runtime-postlude'
import { questionAnswerWaitPrefix } from '../../orchestration/question-answer-delivery'

export abstract class OrcaRuntimeWithRefreshFloatingWorkspacePtyLiveness extends OrcaRuntimeWithRefreshPtyWorktreeRecordsWithControllerInventory {
  protected refreshFloatingWorkspacePtyLiveness(): Set<string> | null {
    const controller = this.ptyController
    if (!controller?.hasPty) {
      return null
    }
    const persistedBindingByPtyId = indexFloatingSnapshotPtyBindings(
      this.mobileSessionTabsByWorktree.get(FLOATING_TERMINAL_WORKTREE_ID),
      (tab) => this.getMobileTerminalPaneKey(tab)
    )
    const knownPtyIds = new Set<string>(persistedBindingByPtyId.keys())
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
          // Restored daemon PTYs need pane identity before mobile can issue safe handles.
          pty = this.recordPtyWorktree(ptyId, FLOATING_TERMINAL_WORKTREE_ID, {
            connected: true,
            tabId: binding.tabId,
            paneKey: binding.paneKey
          })
        }
        if (pty) {
          pty.connected = true
          pty.disconnectedAt = null
          this.markPtyLivenessLive(ptyId)
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
    // Keep disconnected records addressable for status/exit, but release their transcripts.
    pty.tailBuffer = []
    pty.tailTranscriptBuffer = []
    pty.tailTranscriptChars = 0
    pty.tailPartialLine = ''
    pty.tailPendingAnsi = ''
    pty.tailRedrawCursor = null
    pty.tailTruncated = false
    pty.tailLinesTotal = 0
    pty.waitBlockedAt = null
    // Empty tails invalidate cached wait scans before resumed output.
    pty.tailWaitState = undefined
  }

  protected pruneDisconnectedPtyRecords(): void {
    const retained = [...this.ptysById.values()]
      .filter((pty) => !pty.connected && !this.leafExistsForPty(pty.ptyId))
      .sort((a, b) => (a.disconnectedAt ?? 0) - (b.disconnectedAt ?? 0))
    const staleCount = Math.max(0, retained.length - DISCONNECTED_PTY_RECORD_MAX)
    for (const stale of retained.slice(0, staleCount)) {
      // Bound retained exited-terminal archives in long-lived runtimes.
      this.dropDisconnectedPtyRecord(stale.ptyId)
    }
  }

  protected dropDisconnectedPtyRecord(ptyId: string): void {
    // Why: pruning can remove a PTY without the normal exit callback.
    const pty = this.ptysById.get(ptyId)
    // Remote disconnect is unverifiable; its host-owned status survives until certified exit.
    const processDeathCertified =
      pty?.connectionId === null ||
      this.ptyLivenessVerdictByPtyId.get(ptyId)?.verdict.status === 'exited'
    if (processDeathCertified) {
      this.clearLiveProgramStatusFacet(ptyId)
      this.reconcileAgentStatusForEndedProcessFn?.(this.collectAgentStatusPaneKeysForPty(ptyId))
    }
    this.advancePtyLifecycleGeneration(ptyId)
    this.pairedRendererSessionOwnedPtyIds.delete(ptyId)
    this.ptysById.delete(ptyId)
    this.pendingPtyHandleReplacementFences.delete(ptyId)
    this.recentPtyOutputById.delete(ptyId)
    this.setupCompletionTokenByPtyId.delete(ptyId)
    this.clearWaitBlockedCheckState(ptyId)
    this.trustDialogStatus.forget(ptyId)
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
    this.liveProgramStatusFacetPtyIds.delete(ptyId)
    this.terminalSpawnCommandsByPtyId.delete(ptyId)
    this.terminalRunFacts.delete(ptyId)
    this.disposePtyTitleTracker(ptyId)
    this.invalidatePtyIncarnationHandle(ptyId)
    this.terminalWaiters.rejectPty(ptyId, 'terminal_handle_stale')
    this.oscTitleScanTailByPtyId.delete(ptyId)
    this.osc7ScanTailByPtyId.delete(ptyId)
    this.terminalCwdByPtyId.delete(ptyId)
    this.terminalFileUriHostnameByPtyId.delete(ptyId)
    this.wslDistroByPtyId.delete(ptyId)
    const handle = this.handleByPtyId.get(ptyId)
    if (handle) {
      // Pruning can bypass onPtyExit; release leader teams here too.
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
    // Heartbeats are stored handled and only record liveness; they never wake a mailbox.
    if (messageType === 'heartbeat') {
      return
    }
    if (!handle.startsWith('dispatch:')) {
      this.mailPointerRepointScheduler.schedule(handle)
    } else {
      // A waiting ask rechecks its question, which a settled Dispatch has closed.
      this.messageWaiters.notifyPrefix(questionAnswerWaitPrefix(handle.slice('dispatch:'.length)))
    }
    this.orchestrationMailboxNotifications.notifyMessageArrived(handle, messageType)
  }
}
