import { reconsiderCreatorRest } from '../../orchestration/workers/turn-stops/worker-presence-report'
import { OrcaRuntimeWithRefreshPtyWorktreeRecordsWithControllerInventory } from './pty-controller-inventory-refresh'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/workspace/identity/floating-workspace-id'
import { indexFloatingSnapshotPtyBindings } from './floating-snapshot-pty-bindings'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../records/runtime-terminal-state-records'

import { botGroupOfRoomMailAddress } from '../../../../shared/bots/bot-group-room-mail'
import { questionAnswerWaitPrefix } from '../../orchestration/mailbox/questions/question-answer-delivery'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
const DISCONNECTED_PTY_RECORD_MAX = 128

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
          this.terminalIdentity.setPtyConnected(pty, true)
          pty.disconnectedAt = null
          this.markPtyLivenessLive(ptyId)
          this.refreshPtyForegroundAgent(ptyId)
        }
      } else if (pty && !this.leafExistsForPty(ptyId)) {
        this.terminalIdentity.setPtyConnected(pty, false)
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
    pty.releasedLinesTotal = Math.max(pty.releasedLinesTotal ?? 0, pty.tailLinesTotal)
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
    let retained = [...this.ptysById.values()].filter(
      (pty) => !pty.connected && !this.leafExistsForPty(pty.ptyId)
    )
    if (retained.length > DISCONNECTED_PTY_RECORD_MAX) {
      // An open slept pane's handle still names its stopped process; that archive goes with the pane.
      retained = retained.filter((pty) => !this.isSleptPanePty(pty))
    }
    retained.sort((a, b) => (a.disconnectedAt ?? 0) - (b.disconnectedAt ?? 0))
    const staleCount = Math.max(0, retained.length - DISCONNECTED_PTY_RECORD_MAX)
    for (const stale of retained.slice(0, staleCount)) {
      // Bound retained exited-terminal archives in long-lived runtimes.
      this.dropDisconnectedPtyRecord(stale.ptyId)
    }
  }

  /** A stopped process whose handle a processless pane still holds: only a sleep keeps it so. The
   *  panes it can name (its own pane by leaf id, its handle's, its incarnation's) are checked by
   *  key; a pane counts when it shows no process and its bound handle still names this one. */
  private isSleptPanePty(pty: RuntimePtyWorktreeRecord): boolean {
    const keys = new Set<string>()
    const pane = pty.paneKey ? parsePaneKey(pty.paneKey) : null
    if (pane) {
      keys.add(this.getLeafKey(pane.tabId, pane.leafId))
      for (const key of this.terminalIdentity.paneCandidates.leavesForId(pane.leafId)) {
        keys.add(key)
      }
    }
    const handle = this.handleByPtyId.get(pty.ptyId)
    const record = handle ? this.handles.get(handle) : undefined
    if (record) {
      keys.add(this.getLeafKey(record.tabId, record.leafId))
    }
    const incarnation = this.handleByPtyIncarnation.get(pty.ptyId)
    if (incarnation?.leafKey) {
      keys.add(incarnation.leafKey)
    }
    for (const key of keys) {
      const bound = this.leaves.get(key)?.ptyId === null ? this.handleByLeafKey.get(key) : undefined
      if (bound && this.handles.get(bound)?.ptyId === pty.ptyId) {
        return true
      }
    }
    return false
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
    this.terminalIdentity.removePty(ptyId)
    this.pendingPtyHandleReplacementFences.delete(ptyId)
    this.recentPtyOutputById.delete(ptyId)
    this.launchComposerReadyByPtyId.delete(ptyId)
    this.setupCompletionTokenByPtyId.delete(ptyId)
    this.clearWaitBlockedCheckState(ptyId)
    this.trustDialogStatus.forget(ptyId)
    this.ptyOutputSequenceById.delete(ptyId)
    this.providerSequenceInitializedPtys.delete(ptyId)
    this.providerSequenceOffsetByPtyId.delete(ptyId)
    this.reattachedProviderSequenceByPtyId.delete(ptyId)
    this.providerSnapshotPreferredPtys.delete(ptyId)
    this.providerModeTrackersByPtyId.delete(ptyId)
    this.providerModeSnapshotScansByPtyId.delete(ptyId)
    this.providerBufferAcquisitionsByPtyId.delete(ptyId)
    this.forgetProviderVisibleState(ptyId)
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
    this.orchestrationMailboxNotifications.forgetReleasedPointerPty(ptyId)
    const handle = this.handleByPtyId.get(ptyId)
    if (handle) {
      this.terminalIdentity.unbindPty(ptyId)
      if (this.handlesMovedOnFrom(handle, ptyId)) {
        return
      }
      // Pruning can bypass onPtyExit; release leader teams here too.
      this.claudeAgentTeams.removeTeamForLeaderHandle(handle)
      this.terminalIdentity.removeSynthetic(handle)
      const record = this.handles.get(handle)
      if (record?.tabId.startsWith('pty:')) {
        this.terminalIdentity.removeHandle(handle)
      }
    }
  }

  /** Whether another process now holds this handle, which a stopped process only aliases. */
  protected handlesMovedOnFrom(handle: string, ptyId: string): boolean {
    const current = this.handles.get(handle)?.ptyId
    return !!current && current !== ptyId
  }

  /** A stopped process still aliasing the handle its successor took over answers to that handle. */
  protected answersToSuccessor(pty: RuntimePtyWorktreeRecord, handle: string): boolean {
    return (
      !pty.connected &&
      this.handleByPtyId.get(pty.ptyId) === handle &&
      this.handlesMovedOnFrom(handle, pty.ptyId)
    )
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

  protected getLeavesForPty(ptyId: string): readonly RuntimeLeafRecord[] {
    return this.leavesByPtyId.get(ptyId) ?? []
  }

  /** Mail for a bot group's room arrived; the runtime copies it into the room. */
  protected botGroupRoomMailArrived(_groupId: string): void {}

  // Keep the notification hook on the runtime as well as on the installed
  // command surface: exit escalation can wake an in-flight --wait directly.
  notifyMessageArrived(handle: string, messageType?: string): void {
    // Heartbeats are stored handled and only record liveness; they never wake a mailbox.
    if (messageType === 'heartbeat') {
      return
    }
    // A bot on another computer answered a group's question: it goes to that room, never a mailbox.
    const roomGroupId = botGroupOfRoomMailAddress(handle)
    if (roomGroupId !== null) {
      this.botGroupRoomMailArrived(roomGroupId)
      return
    }
    if (!handle.startsWith('dispatch:')) {
      this.mailPointerRepointScheduler.schedule(handle)
    } else {
      // A waiting ask rechecks its question, which a settled Dispatch has closed.
      this.messageWaiters.notifyPrefix(questionAnswerWaitPrefix(handle.slice('dispatch:'.length)))
      // A helper that settled may have been all that held back its creator's report.
      reconsiderCreatorRest(handle, this.workerTurnStopReportDeps)
    }
    this.orchestrationMailboxNotifications.notifyMessageArrived(handle, messageType)
  }
}
