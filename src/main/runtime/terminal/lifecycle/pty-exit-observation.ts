import { advertisedUrlWatcher } from '../../../ports/advertised-url-watcher'
import { OrcaRuntimeWithOnClientDisconnected } from '../layout/terminal-client-disconnect'
import type {
  RuntimePtyWorktreeRecord,
  RuntimeLeafRecord
} from '../../runtime-terminal-state-records'
import type { TerminalExitCause } from '../../../../shared/terminal/pty/lifecycle/terminal-exit-cause'
import type { PtyLivenessVerdict } from '../../../../shared/terminal/pty/lifecycle/pty-liveness-verdict'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { PtyIncarnationId } from '../../../../shared/terminal/pty/lifecycle/pty-incarnation'
import { closedPaneOfExitedPty, type ClosedPaneOfExit } from './closed-pane-of-exited-pty'

type ExitObservation = {
  ptyId: string
  pty: RuntimePtyWorktreeRecord | undefined
  isCurrent: () => boolean
  processDeathCertified: boolean
  exitIncarnationId: string | undefined
  candidateIncarnation: string | null | undefined
  exitCause: TerminalExitCause
  exitCode: number
  leaves: { leaf: RuntimeLeafRecord; handle: string | undefined }[]
  ptyHandle: string | undefined
  closedPane: ClosedPaneOfExit | null
  recordedPaneKey: string | null
  preservesAbnormalSshSurface: boolean
  endedOnItsOwn: boolean
  preservesIntentionallyStoppedSurface: boolean
  hostLost: boolean | undefined
}

export abstract class OrcaRuntimeWithPtyExitObservation extends OrcaRuntimeWithOnClientDisconnected {
  protected abstract pruneDisconnectedPtyRecords(): void
  protected abstract failActiveDispatchOnExit(
    handle: string,
    paneKey: string | null,
    exitCode: number,
    cause: TerminalExitCause
  ): void
  protected abstract pruneDisconnectedPtyTranscript(pty: RuntimePtyWorktreeRecord): void
  protected abstract rememberPtyLivenessVerdict(ptyId: string, verdict: PtyLivenessVerdict): void
  protected notePtyEndedOnItsOwn(_pty: RuntimePtyWorktreeRecord): void {}

  /** The pane main's close already dropped, from its closed-pane record; null while main holds it. */
  protected closedPaneOfExit(
    pty: RuntimePtyWorktreeRecord | undefined,
    exitIncarnationId: PtyIncarnationId | undefined
  ): ClosedPaneOfExit | null {
    if (!ORCA_LAYOUT_OWNER_IS_MAIN || !pty || this.paneOfPty(pty).paneKey) {
      return null
    }
    return closedPaneOfExitedPty(
      this.store,
      this.tryGetWorkspaceSessionHostIdForWorktree(pty.worktreeId),
      pty,
      exitIncarnationId ?? pty.incarnationId
    )
  }

  protected clearExitedPtyObservations(ptyId: string): void {
    advertisedUrlWatcher.unbindPty(ptyId)
    this.mobileSubscribers.delete(ptyId)
    this.terminalViewSubscribers.clearSubscribers(ptyId)
    this.mainDaemonAttachments.forget(ptyId)
    this.mobileDisplayModes.delete(ptyId)
    this.resizeListeners.delete(ptyId)
    this.lastRendererSizes.delete(ptyId)
    this.recentPtyOutputById.delete(ptyId)
    this.launchComposerReadyByPtyId.delete(ptyId)
    this.setupCompletionTokenByPtyId.delete(ptyId)
    this.clearWaitBlockedCheckState(ptyId)
    this.ptyOutputSequenceById.delete(ptyId)
    this.providerSequenceInitializedPtys.delete(ptyId)
    this.providerSequenceOffsetByPtyId.delete(ptyId)
    this.providerSnapshotPreferredPtys.delete(ptyId)
    this.providerModeTrackersByPtyId.delete(ptyId)
    this.providerModeSnapshotScansByPtyId.delete(ptyId)
    this.providerBufferAcquisitionsByPtyId.delete(ptyId)
    this.providerVisibleStateByPtyId.delete(ptyId)
    this.providerVisibleRetryAtByPtyId.delete(ptyId)
    this.agentPromptExplicitStatusFloorByPtyId.delete(ptyId)
    this.ptyLifecycleGenerationById.delete(ptyId)
    this.agentStatusOscProcessorsByPtyId.delete(ptyId)
    this.liveProgramStatusFacetPtyIds.delete(ptyId)
    this.terminalSpawnCommandsByPtyId.delete(ptyId)
    this.disposePtyTitleTracker(ptyId)
    this.oscTitleScanTailByPtyId.delete(ptyId)
    this.osc7ScanTailByPtyId.delete(ptyId)
    this.terminalCwdByPtyId.delete(ptyId)
    this.terminalFileUriHostnameByPtyId.delete(ptyId)
    this.wslDistroByPtyId.delete(ptyId)
  }

  protected observePtyExit({
    ptyId,
    pty,
    isCurrent,
    processDeathCertified,
    exitIncarnationId,
    candidateIncarnation,
    exitCause,
    exitCode,
    leaves,
    ptyHandle,
    closedPane,
    recordedPaneKey,
    preservesAbnormalSshSurface,
    endedOnItsOwn,
    preservesIntentionallyStoppedSurface,
    hostLost
  }: ExitObservation): void {
    if (!isCurrent()) {
      return
    }
    if (processDeathCertified) {
      this.rememberPtyLivenessVerdict(ptyId, {
        status: 'exited',
        incarnationId: exitIncarnationId ?? candidateIncarnation ?? undefined,
        cause: exitCause
      })
    }
    if (pty) {
      this.terminalIdentity.setPtyConnected(pty, false)
      pty.runtimeSessionOwned = false
      this.setPairedRendererSessionOwnership(pty.ptyId, false)
      if (!isCurrent()) {
        return
      }
      pty.disconnectedAt = Date.now()
      pty.lastExitCode = exitCode
      pty.lastExitCause = exitCause
      pty.lastAgentStatusObservedLive = false
      this.pruneDisconnectedPtyTranscript(pty)
    }
    if (!isCurrent()) {
      return
    }
    const exitedSurfaces: { handle: string; paneKey: string | null }[] = []
    for (const { leaf, handle } of leaves) {
      if (!isCurrent()) {
        return
      }
      if (
        this.leaves.get(this.getLeafKey(leaf.tabId, leaf.leafId)) !== leaf ||
        leaf.ptyId !== ptyId
      ) {
        continue
      }
      this.detachedPreAllocatedLeaves.delete(ptyId)
      this.terminalIdentity.updateLeafConnected(leaf, false)
      leaf.writable = false
      leaf.lastExitCode = exitCode
      leaf.lastExitCause = exitCause
      leaf.lastAgentStatusObservedLive = false
      if (handle) {
        exitedSurfaces.push({ handle, paneKey: `${leaf.tabId}:${leaf.leafId}` })
      }
    }
    if (ptyHandle && !exitedSurfaces.some((surface) => surface.handle === ptyHandle)) {
      exitedSurfaces.push({ handle: ptyHandle, paneKey: closedPane?.paneKey ?? recordedPaneKey })
    }
    if (!preservesAbnormalSshSurface) {
      for (const surface of exitedSurfaces) {
        if (!isCurrent()) {
          return
        }
        this.failActiveDispatchOnExit(surface.handle, surface.paneKey, exitCode, exitCause)
      }
    }
    if (!isCurrent()) {
      return
    }
    if (pty && endedOnItsOwn && !preservesIntentionallyStoppedSurface) {
      this.notePtyEndedOnItsOwn(pty)
    }
    if (!isCurrent()) {
      return
    }
    if (preservesIntentionallyStoppedSurface || preservesAbnormalSshSurface || hostLost === true) {
      this.touchMobileSessionSnapshotsForPty(ptyId, { immediate: true })
    }
    if (isCurrent()) {
      this.pruneDisconnectedPtyRecords()
    }
  }
  protected notifyPtyExitListeners(listeners: Set<() => void> | undefined): void {
    if (!listeners) {
      return
    }
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // A subscriber cannot change exit cleanup for other waiters.
      }
    }
  }
}
