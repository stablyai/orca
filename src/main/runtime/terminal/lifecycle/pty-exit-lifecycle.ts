import { OrcaRuntimeWithOnClientDisconnected } from '../layout/terminal-client-disconnect'
import type { PtyIncarnationId } from '../../../../shared/pty-incarnation'
import type { TerminalExitCause } from '../../../../shared/terminal-exit-cause'
import {
  OPERATOR_CLOSE_EXIT_CAUSE,
  resolveUnreportedExitCause
} from '../../../../shared/terminal-exit-cause'
import { SSH_EXIT_UNCONFIRMED_REASON } from '../../../../shared/pty-liveness-verdict'
import type { RetiredTerminalSurface } from '../../mobile-session-terminal-retirement'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { advertisedUrlWatcher } from '../../../ports/advertised-url-watcher'
import type { PtyLivenessVerdict } from '../../../../shared/pty-liveness-verdict'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { exitedSplitPaneFacts } from './exited-split-pane-rule'
import { closedPaneOfExitedPty, type ClosedPaneOfExit } from './closed-pane-of-exited-pty'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'

export abstract class OrcaRuntimeWithOnPtyExit extends OrcaRuntimeWithOnClientDisconnected {
  protected abstract pruneDisconnectedPtyRecords(): void

  protected abstract failActiveDispatchOnExit(
    handle: string,
    paneKey: string | null,
    exitCode: number,
    cause: TerminalExitCause
  ): void

  protected abstract pruneDisconnectedPtyTranscript(pty: RuntimePtyWorktreeRecord): void

  protected abstract resolvePtyExitWaiters(pty: RuntimePtyWorktreeRecord, ptyId: string): void

  protected abstract cancelPendingDriverMutations(ptyId: string): void

  protected abstract rememberPtyLivenessVerdict(ptyId: string, verdict: PtyLivenessVerdict): void

  /** The pane main's close already dropped, from its closed-pane record; null while main holds it. */
  private closedPaneOfExit(
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

  onPtyExit(
    ptyId: string,
    exitCode: number,
    exitIncarnationId?: PtyIncarnationId,
    options: {
      hostExitConfirmed?: boolean
      cause?: TerminalExitCause
      /** Physical provider exit differs from hostExitConfirmed: node-pty can report a real exit as -1, indistinguishable numerically from failed stops. */
      providerExitObserved?: boolean
      /** A window's view of the pane was showing when it ended (layout-owner build). */
      viewShown?: boolean
      /** Its host went away (a WSL bridge pane's distro stopped): keep the pane to cold-restore, as after a daemon crash. */
      hostLost?: boolean
    } = {}
  ): void | Promise<void> {
    const pty = this.ptysById.get(ptyId)
    const pending = this.pendingPtyRegistrationIncarnations.get(ptyId)
    const candidateIncarnation = pending ? pending.incarnationId : pty?.incarnationId
    if (exitIncarnationId && candidateIncarnation && exitIncarnationId !== candidateIncarnation) {
      return
    }
    pending?.exitedIncarnations.add(exitIncarnationId ?? candidateIncarnation ?? null)
    this.invalidatePtyControllerInventoryForLifecycle(ptyId, pty?.connectionId)
    // A bare exit code is not enough to establish why a process ended: older
    // daemons and SSH relays can report 0 for crashes and wrapper exits.
    const observedCause = options.cause ?? resolveUnreportedExitCause(exitCode)
    const stopNeverConfirmed =
      observedCause.kind === 'unknown' && observedCause.reason === 'stop_unverified'
    const stopRequested = this.stopRequestedPtyIds.has(ptyId)
    const exitCause: TerminalExitCause =
      stopRequested && !stopNeverConfirmed ? OPERATOR_CLOSE_EXIT_CAUSE : observedCause
    this.stopRequestedPtyIds.delete(ptyId)
    const preservesAbnormalSshSurface =
      this.isSshOwnedPtyId(ptyId) &&
      pty?.connectionId != null &&
      exitCode < 0 &&
      options.hostExitConfirmed !== true
    // Why: collect before retirePtyAgentLaunchAuthority, which deletes the restored-authority
    // receipt a receipt-only pane's key comes from.
    const exitPaneKeys = this.collectAgentStatusPaneKeysForPty(ptyId)
    const closedPane = this.closedPaneOfExit(pty, exitIncarnationId)
    if (closedPane) {
      exitPaneKeys.add(closedPane.paneKey)
    }
    if (preservesAbnormalSshSurface) {
      const prior = this.ptyLivenessVerdictByPtyId.get(ptyId)?.verdict
      this.rememberPtyLivenessVerdict(ptyId, {
        status: 'unverifiable',
        reason: prior?.status === 'unverifiable' ? prior.reason : SSH_EXIT_UNCONFIRMED_REASON
      })
      this.restoredOrchestrationAuthorityByPtyId.delete(ptyId)
    } else {
      this.retirePtyAgentLaunchAuthority(ptyId)
    }
    const processDeathCertified =
      exitCode >= 0 || options.hostExitConfirmed === true || options.providerExitObserved === true
    if (processDeathCertified) {
      // An unverifiable exit keeps the facet tracked until a certified exit or prune.
      this.clearLiveProgramStatusFacet(ptyId)
    }
    if (processDeathCertified && exitPaneKeys.size > 0) {
      this.reconcileAgentStatusForEndedProcessFn?.(exitPaneKeys)
    }
    const incarnationId =
      exitIncarnationId ??
      pty?.incarnationId ??
      `runtime:${this.runtimeId}:${this.getPtyLifecycleGeneration(ptyId)}`
    this.advancePtyLifecycleGeneration(ptyId)
    let retirement: Promise<void> | undefined
    try {
      const exactSurfaceByKey = new Map<
        string,
        Pick<RetiredTerminalSurface, 'worktreeId' | 'parentTabId' | 'leafId'>
      >()
      for (const [worktreeId, snapshot] of this.mobileSessionTabsByWorktree) {
        for (const tab of snapshot.tabs) {
          if (
            tab.type === 'terminal' &&
            (tab.ptyId === ptyId || tab.parentLayout?.ptyIdsByLeafId?.[tab.leafId] === ptyId)
          ) {
            exactSurfaceByKey.set(`${worktreeId}\0${tab.parentTabId}\0${tab.leafId}`, {
              worktreeId,
              parentTabId: tab.parentTabId,
              leafId: tab.leafId
            })
          }
        }
      }
      for (const leaf of this.getLeavesForPty(ptyId)) {
        exactSurfaceByKey.set(`${leaf.worktreeId}\0${leaf.tabId}\0${leaf.leafId}`, {
          worktreeId: leaf.worktreeId,
          parentTabId: leaf.tabId,
          leafId: leaf.leafId
        })
      }
      const recorded = closedPane ?? this.paneOfPty(pty)
      const parsedPaneKey = parsePaneKey(recorded.paneKey ?? '')
      if (pty && recorded.tabId && parsedPaneKey) {
        exactSurfaceByKey.set(`${pty.worktreeId}\0${recorded.tabId}\0${parsedPaneKey.leafId}`, {
          worktreeId: pty.worktreeId,
          parentTabId: recorded.tabId,
          leafId: parsedPaneKey.leafId
        })
      }
      const exactSurfaces = [...exactSurfaceByKey.values()]
      // Why both kinds: a sleep keeps its wake hint, and a restart's replacement takes the pane.
      const preservesIntentionallyStoppedSurface =
        this.intentionalPtyStops.claimExit(ptyId, exitIncarnationId ?? pty?.incarnationId).length >
        0
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
      // Natural exits must release Claude leader teams too; explicit-close-only cleanup leaked teams for the runtime lifetime.
      const exitedTeamLeaderHandle = this.handleByPtyId.get(ptyId)
      if (exitedTeamLeaderHandle) {
        this.claudeAgentTeams.removeTeamForLeaderHandle(exitedTeamLeaderHandle)
      }
      // Queued layout work rechecks missing layout and refuses pty-exited after cleanup.
      this.layouts.delete(ptyId)
      this.layoutQueues.delete(ptyId)
      this.freshSubscribeGuard.delete(ptyId)
      this.cancelPendingDriverMutations(ptyId)
      // Cold restore can reuse ids during delayed Enter; revoke it before it injects into a replacement.
      this.orchestrationMailboxNotifications.retirePty(ptyId)
      // Repoint retained handle/pane mailbox pointers away from the retired session.
      for (const leaf of this.getLeavesForPty(ptyId)) {
        const mailboxHandle = this.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId))
        if (mailboxHandle) {
          this.mailPointerRepointScheduler.schedule(mailboxHandle)
        }
        for (const boundRun of this._orchestrationDb?.runsBoundToPane?.(
          `${leaf.tabId}:${leaf.leafId}`
        ) ?? []) {
          this.mailPointerRepointScheduler.schedule(`run:${boundRun.id}`)
        }
      }

      if (this.terminalFitOverrides.has(ptyId)) {
        this.terminalFitOverrides.delete(ptyId)
        this.notifier?.terminalFitOverrideChanged(ptyId, 'desktop-fit', 0, 0)
        this.notifyFitOverrideListeners(ptyId, 'desktop-fit', 0, 0)
      }
      // Clear and notify driver state so dead panes cannot retain mobile lock banners.
      this.terminalDrivers.clear(ptyId)
      this.remoteDesktopFloor.clearPty(ptyId)
      this.disposeHeadlessTerminal(ptyId)
      this.trustDialogStatus.forget(ptyId)
      if (processDeathCertified) {
        // The bounded verdict register also fences late graphs after the PTY record was pruned.
        this.rememberPtyLivenessVerdict(ptyId, {
          status: 'exited',
          incarnationId: exitIncarnationId ?? candidateIncarnation ?? undefined,
          cause: exitCause
        })
      }
      if (pty) {
        pty.connected = false
        pty.runtimeSessionOwned = false
        this.setPairedRendererSessionOwnership(pty.ptyId, false)
        pty.disconnectedAt = Date.now()
        pty.lastExitCode = exitCode
        pty.lastExitCause = exitCause
        // Same-id replacements must earn live idle evidence before delivery; retain status only for display.
        pty.lastAgentStatusObservedLive = false
        this.resolvePtyExitWaiters(pty, ptyId)
        this.pruneDisconnectedPtyTranscript(pty)
      }
      if (
        preservesIntentionallyStoppedSurface ||
        preservesAbnormalSshSurface ||
        options.hostLost === true
      ) {
        // Why: relay loss is recoverable; keep the HUB-owned pane addressable through the bounded reconnect grace.
        this.touchMobileSessionSnapshotsForPty(ptyId, { immediate: true })
      } else {
        // Why: permanent process exit is absence, not a starting/sleeping tab.
        // Retire before publishing so paired clients never persist a ghost.
        try {
          retirement = this.retireMobileSessionSurfacesForPty(
            ptyId,
            incarnationId,
            exactSurfaces,
            // Switch point: main decides an exited split pane's close.
            ORCA_LAYOUT_OWNER_IS_MAIN
              ? exitedSplitPaneFacts(this.terminalRunFacts, pty, ptyId, exitCode, options)
              : undefined,
            closedPane ?? undefined
          )
        } catch (error) {
          console.error('[runtime] failed to publish terminal retirement:', error)
        }
      }
    } finally {
      // Why last: a stream end cues clients to re-activate the pane it ended, so the retirement
      // must precede it; a cleanup fault must still end the stream.
      this.notifyPtyExitListeners(ptyId)
    }

    const exitedSurfaces: { handle: string; paneKey: string | null }[] = []
    for (const leaf of this.getLeavesForPty(ptyId)) {
      this.detachedPreAllocatedLeaves.delete(ptyId)
      leaf.connected = false
      leaf.writable = false
      leaf.lastExitCode = exitCode
      leaf.lastExitCause = exitCause
      leaf.lastAgentStatusObservedLive = false
      const leafHandle = this.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId))
      if (leafHandle) {
        exitedSurfaces.push({ handle: leafHandle, paneKey: `${leaf.tabId}:${leaf.leafId}` })
      }
    }
    // Tab close can remove graph leaves before exit; settle dispatches through surviving PTY handle/pane identity too (STA-4603).
    const ptyHandle = this.handleByPtyId.get(ptyId)
    if (ptyHandle && !exitedSurfaces.some((surface) => surface.handle === ptyHandle)) {
      exitedSurfaces.push({
        handle: ptyHandle,
        paneKey: closedPane?.paneKey ?? this.paneOfPty(pty).paneKey
      })
    }
    if (!preservesAbnormalSshSurface) {
      for (const surface of exitedSurfaces) {
        this.failActiveDispatchOnExit(surface.handle, surface.paneKey, exitCode, exitCause)
      }
    }
    this.pruneDisconnectedPtyRecords()
    return retirement
  }

  private notifyPtyExitListeners(ptyId: string): void {
    const listeners = this.ptyExitListenersByPtyId.get(ptyId)
    if (!listeners) {
      return
    }
    this.ptyExitListenersByPtyId.delete(ptyId)
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // A subscriber cannot change exit cleanup for other waiters.
      }
    }
  }
}
