// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithOnClientDisconnected } from './orca-runtime-on-client-disconnected'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import {
  OPERATOR_CLOSE_EXIT_CAUSE,
  resolveUnreportedExitCause
} from '../../shared/terminal-exit-cause'
import { SSH_EXIT_UNCONFIRMED_REASON } from '../../shared/pty-liveness-verdict'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import type { RetiredTerminalSurface } from './mobile-session-terminal-retirement'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { advertisedUrlWatcher } from '../ports/advertised-url-watcher'

export class OrcaRuntimeWithOnPtyExit extends OrcaRuntimeWithOnClientDisconnected {
  onPtyExit(
    ptyId: string,
    exitCode: number,
    exitIncarnationId?: PtyIncarnationId,
    options: {
      hostExitConfirmed?: boolean
      cause?: TerminalExitCause
      /** The provider's own physical-exit callback fired. Separate from `hostExitConfirmed`, which
       * also drives the SSH surface decision and the liveness verdict: node-pty reports real exits
       * as -1, so the numeric code alone cannot tell a dead process from a failed stop. */
      providerExitObserved?: boolean
    } = {}
  ): void {
    const pty = this.ptysById.get(ptyId)
    if (exitIncarnationId && pty?.incarnationId && exitIncarnationId !== pty.incarnationId) {
      return
    }
    // A bare exit code is not enough to establish why a process ended: older
    // daemons and SSH relays can report 0 for crashes and wrapper exits.
    const observedCause = options.cause ?? resolveUnreportedExitCause(exitCode)
    const stopNeverConfirmed =
      observedCause.kind === 'unknown' && observedCause.reason === 'stop_unverified'
    const exitCause: TerminalExitCause =
      this.stopRequestedPtyIds.has(ptyId) && !stopNeverConfirmed
        ? OPERATOR_CLOSE_EXIT_CAUSE
        : observedCause
    this.stopRequestedPtyIds.delete(ptyId)
    const preservesAbnormalSshSurface =
      this.isSshOwnedPtyId(ptyId) &&
      pty?.connectionId != null &&
      exitCode < 0 &&
      options.hostExitConfirmed !== true
    // Why: collect before retirePtyAgentLaunchAuthority, which deletes the restored-authority
    // receipt a receipt-only pane's key comes from.
    const exitPaneKeys = this.collectPaneKeysForPty(ptyId)
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
    if (processDeathCertified && exitPaneKeys.size > 0) {
      this.reconcileAgentStatusForEndedProcessFn?.(exitPaneKeys)
    }
    const incarnationId =
      exitIncarnationId ??
      pty?.incarnationId ??
      `runtime:${this.runtimeId}:${this.getPtyLifecycleGeneration(ptyId)}`
    this.advancePtyLifecycleGeneration(ptyId)
    this.notifyPtyExitListeners(ptyId)
    const exactSurfaceByKey = new Map<
      string,
      Pick<RetiredTerminalSurface, 'worktreeId' | 'parentTabId' | 'leafId'>
    >()
    for (const [worktreeId, snapshot] of this.mobileSessionTabsByWorktree) {
      for (const tab of snapshot.tabs) {
        if (tab.type === 'terminal' && tab.ptyId === ptyId) {
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
    const parsedPaneKey = parsePaneKey(pty?.paneKey ?? '')
    if (pty?.tabId && parsedPaneKey) {
      exactSurfaceByKey.set(`${pty.worktreeId}\0${pty.tabId}\0${parsedPaneKey.leafId}`, {
        worktreeId: pty.worktreeId,
        parentTabId: pty.tabId,
        leafId: parsedPaneKey.leafId
      })
    }
    const exactSurfaces = [...exactSurfaceByKey.values()]
    const pendingIncarnation = this.pendingPtyRegistrationIncarnations.get(ptyId)
    const exitMatchesPendingRegistration =
      this.pendingPtyRegistrationIncarnations.has(ptyId) &&
      (pendingIncarnation === null ||
        exitIncarnationId === null ||
        exitIncarnationId === undefined ||
        pendingIncarnation === exitIncarnationId)
    if (exitMatchesPendingRegistration) {
      // Why: reused surfaces can look registered while their replacement incarnation still awaits admission.
      this.earlyExitedPtyIncarnations.set(
        ptyId,
        exitIncarnationId ?? pendingIncarnation ?? pty?.incarnationId ?? null
      )
    }
    const intentionalStopIncarnation = this.intentionalHandlelessPtyStops.get(ptyId)
    const preservesIntentionalHandlelessSurface =
      this.intentionalHandlelessPtyStops.has(ptyId) &&
      (intentionalStopIncarnation === null || intentionalStopIncarnation === incarnationId)
    advertisedUrlWatcher.unbindPty(ptyId)
    agentSessionPtyWriteGate.unbindPty(ptyId)
    // Clean up new mobile state for this PTY
    this.mobileSubscribers.delete(ptyId)
    this.terminalViewSubscribers.clearSubscribers(ptyId)
    this.mobileDisplayModes.delete(ptyId)
    this.resizeListeners.delete(ptyId)
    this.lastRendererSizes.delete(ptyId)
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
    this.agentPromptExplicitStatusFloorByPtyId.delete(ptyId)
    // Safe against respawn: `getPtyLifecycleGeneration` lazily mints from the
    // monotonic `nextPtyLifecycleGeneration`, so a re-read after this delete
    // returns a strictly newer number — never a reused one. Every comparison a
    // stale frame makes therefore still fails, exactly as the advance above intends.
    this.ptyLifecycleGenerationById.delete(ptyId)
    this.agentStatusOscProcessorsByPtyId.delete(ptyId)
    this.terminalSpawnCommandsByPtyId.delete(ptyId)
    this.disposePtyTitleTracker(ptyId)
    this.oscTitleScanTailByPtyId.delete(ptyId)
    this.osc7ScanTailByPtyId.delete(ptyId)
    this.terminalCwdByPtyId.delete(ptyId)
    this.terminalFileUriHostnameByPtyId.delete(ptyId)
    this.wslDistroByPtyId.delete(ptyId)
    this.clearAgentRowSnapshotsForPty(ptyId)
    // Why: a Claude agent-team leader whose PTY exits naturally (agent finished,
    // process died, renderer reload) must release its team + nested panes map.
    // Previously only explicit closeTerminal evicted it, so natural exits leaked
    // one team per never-reused teamId for the runtime's lifetime.
    const exitedTeamLeaderHandle = this.handleByPtyId.get(ptyId)
    if (exitedTeamLeaderHandle) {
      this.claudeAgentTeams.removeTeamForLeaderHandle(exitedTeamLeaderHandle)
    }
    // Layout state machine: clear `layouts` and `layoutQueues`. Any
    // already-queued applyLayout work for this ptyId will run, but every
    // applyLayout re-checks `layouts.has(ptyId)` (or fresh-subscribe) and
    // short-circuits with `pty-exited`.
    this.layouts.delete(ptyId)
    this.layoutQueues.delete(ptyId)
    this.freshSubscribeGuard.delete(ptyId)
    this.cancelPendingDriverMutations(ptyId)
    // Why: a cold restore can respawn under the same session id within the
    // delayed-Enter window; the armed Enter would inject \r into the
    // replacement and stamp rows it never received.
    this.orchestrationMailboxNotifications.retirePty(ptyId)
    // Why: the dead pty's terminal handle and any run bound to its panes still carry mailbox
    // pointers; schedule a debounced repoint so they do not stay aimed at a retired session.
    for (const leaf of this.getLeavesForPty(ptyId)) {
      const mailboxHandle = this.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId))
      if (mailboxHandle) {
        this.mailPointerRepointScheduler.schedule(mailboxHandle)
      }
      const boundRun = this._orchestrationDb?.getCurrentRunForPane?.(`${leaf.tabId}:${leaf.leafId}`)
      if (boundRun) {
        this.mailPointerRepointScheduler.schedule(`run:${boundRun.id}`)
      }
    }

    if (this.terminalFitOverrides.has(ptyId)) {
      this.terminalFitOverrides.delete(ptyId)
      this.notifier?.terminalFitOverrideChanged(ptyId, 'desktop-fit', 0, 0)
      this.notifyFitOverrideListeners(ptyId, 'desktop-fit', 0, 0)
    }
    // Why: clear driver state and notify the renderer so any lock banner on
    // this dead pane unmounts. Without this, the pane shows a stuck banner
    // until tab teardown, and `getDriver(deadPtyId)` would keep returning a
    // stale `mobile{X}` to any caller that hasn't yet seen the exit IPC.
    this.terminalDrivers.clear(ptyId)
    this.remoteDesktopFloor.clearPty(ptyId)
    this.disposeHeadlessTerminal(ptyId)
    if (pty) {
      pty.connected = false
      pty.runtimeSessionOwned = false
      this.setPairedRendererSessionOwnership(pty.ptyId, false)
      pty.disconnectedAt = Date.now()
      pty.lastExitCode = exitCode
      pty.lastExitCause = exitCause
      if (exitCode >= 0 || options.hostExitConfirmed === true) {
        // Record the certificate rather than merely dropping the doubt: a reader that has to
        // authorize a respawn cannot distinguish "the host reported this process gone" from "this
        // runtime has never asked" if both are absence.
        this.rememberPtyLivenessVerdict(ptyId, { status: 'exited' })
      }
      // Why: the exited process's live frames say nothing about a replacement.
      // A same-id respawn makes the leaf writable again before any new title,
      // so leaving this true would let push delivery type into the new process
      // on the dead one's idle. lastAgentStatus itself stays for `ps` display.
      pty.lastAgentStatusObservedLive = false
      this.resolvePtyExitWaiters(pty, ptyId)
      this.pruneDisconnectedPtyTranscript(pty)
    }
    if (preservesIntentionalHandlelessSurface || preservesAbnormalSshSurface) {
      // Why: relay loss is recoverable; keep the HUB-owned pane addressable through the bounded reconnect grace.
      this.touchMobileSessionSnapshotsForPty(ptyId, { immediate: true })
    } else {
      // Why: permanent process exit is absence, not a starting/sleeping tab.
      // Retire before publishing so paired clients never persist a ghost.
      this.retireMobileSessionSurfacesForPty(ptyId, incarnationId, exactSurfaces)
    }

    const exitedSurfaces: { handle: string; paneKey: string | null }[] = []
    for (const leaf of this.getLeavesForPty(ptyId)) {
      this.detachedPreAllocatedLeaves.delete(ptyId)
      leaf.connected = false
      leaf.writable = false
      leaf.lastExitCode = exitCode
      leaf.lastExitCause = exitCause
      leaf.lastAgentStatusObservedLive = false
      this.resolveExitWaiters(leaf)
      const leafHandle = this.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId))
      if (leafHandle) {
        exitedSurfaces.push({ handle: leafHandle, paneKey: `${leaf.tabId}:${leaf.leafId}` })
      }
    }
    // Why: an explicit whole-tab close drops the leaf from the graph *before*
    // this exit lands, so a leaf-only walk found nothing and left the dispatch
    // reading 'dispatched' forever. The PTY's own handle and pane key survive
    // that teardown, so settle from them too (STA-4603).
    const ptyHandle = this.handleByPtyId.get(ptyId)
    if (ptyHandle && !exitedSurfaces.some((surface) => surface.handle === ptyHandle)) {
      exitedSurfaces.push({ handle: ptyHandle, paneKey: pty?.paneKey ?? null })
    }
    if (!preservesAbnormalSshSurface) {
      for (const surface of exitedSurfaces) {
        this.failActiveDispatchOnExit(surface.handle, surface.paneKey, exitCode, exitCause)
      }
    }
    this.pruneDisconnectedPtyRecords()
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
