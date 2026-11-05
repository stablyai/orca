import { OrcaRuntimeWithPtyExitObservation } from './pty-exit-observation'
import type { PtyIncarnationId } from '../../../../shared/terminal/pty/lifecycle/pty-incarnation'

import {
  type TerminalExitCause,
  OPERATOR_CLOSE_EXIT_CAUSE,
  resolveUnreportedExitCause
} from '../../../../shared/terminal/pty/lifecycle/terminal-exit-cause'
import { SSH_EXIT_UNCONFIRMED_REASON } from '../../../../shared/terminal/pty/lifecycle/pty-liveness-verdict'
import type { RetiredTerminalSurface } from '../../mobile-session-terminal-retirement'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'

import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { exitedSplitPaneFacts } from './exited-split-pane-rule'
import type { TerminalWaiter } from '../../runtime-terminal-contracts'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'

export abstract class OrcaRuntimeWithOnPtyExit extends OrcaRuntimeWithPtyExitObservation {
  protected abstract resolvePtyExitWaiters(
    exit: Pick<RuntimePtyWorktreeRecord, 'connected' | 'lastExitCode' | 'lastExitCause'>,
    waiters: readonly TerminalWaiter[]
  ): void

  protected abstract cancelPendingDriverMutations(ptyId: string): void

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
    const recordIncarnation = pty?.incarnationId
    const pendingIncarnation = pending?.incarnationId
    const isCurrent = (): boolean =>
      this.ptysById.get(ptyId) === pty &&
      (!pty || pty.incarnationId === recordIncarnation) &&
      this.pendingPtyRegistrationIncarnations.get(ptyId) === pending &&
      pending?.incarnationId === pendingIncarnation
    const listeners = this.ptyExitListenersByPtyId.get(ptyId)
    this.ptyExitListenersByPtyId.delete(ptyId)
    const waiters = this.terminalWaiters.forPty(ptyId)
    const leaves = this.getLeavesForPty(ptyId).map((leaf) => ({
      leaf,
      handle: this.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId))
    }))
    const ptyHandle = this.handleByPtyId.get(ptyId)
    const attachRelease = this.intentionalPtyStops.captureExitRelease(
      ptyId,
      exitIncarnationId ?? recordIncarnation
    )
    pending?.exitedIncarnations.add(exitIncarnationId ?? candidateIncarnation ?? null)
    // A stop's cleanup can report the exit again, after its stop request is spent.
    const priorExit = this.getPtyLivenessVerdict(ptyId)
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
    const recordedPaneKey = this.paneOfPty(pty).paneKey
    if (closedPane) {
      exitPaneKeys.add(closedPane.paneKey)
    }
    const processDeathCertified =
      exitCode >= 0 || options.hostExitConfirmed === true || options.providerExitObserved === true
    const endedOnItsOwn =
      processDeathCertified &&
      !stopRequested &&
      options.hostLost !== true &&
      !(
        priorExit?.status === 'exited' &&
        priorExit.incarnationId === (pty?.incarnationId ?? undefined)
      )
    const incarnationId =
      exitIncarnationId ??
      recordIncarnation ??
      `runtime:${this.runtimeId}:${this.getPtyLifecycleGeneration(ptyId)}`
    this.advancePtyLifecycleGeneration(ptyId)
    let retirement: Promise<void> | undefined
    let preservesIntentionallyStoppedSurface = false
    const completeExit = (): void =>
      this.observePtyExit({
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
        hostLost: options.hostLost
      })
    try {
      // Settle the captured wait before cleanup callbacks can re-register and reject it as stale.
      if (pty) {
        this.resolvePtyExitWaiters(
          { connected: false, lastExitCode: exitCode, lastExitCause: exitCause },
          waiters
        )
      }
      if (!isCurrent()) {
        return retirement
      }
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
      for (const { leaf } of leaves) {
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
      const intentionalStops = this.intentionalPtyStops.claimExit(
        ptyId,
        exitIncarnationId ?? pty?.incarnationId
      )
      preservesIntentionallyStoppedSurface = intentionalStops.length > 0
      if (
        intentionalStops.includes('reversible') &&
        processDeathCertified &&
        options.hostLost !== true &&
        !preservesAbnormalSshSurface
      ) {
        retirement = this.releaseStoppedPaneBindings(
          ptyId,
          exitIncarnationId ?? candidateIncarnation ?? undefined,
          exactSurfaces
        ).catch((error: unknown) => {
          console.error('[runtime] could not release stopped pane binding:', error)
        })
        attachRelease(retirement)
      }
      if (!isCurrent()) {
        return retirement
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
      if (!isCurrent()) {
        return retirement
      }
      if (processDeathCertified) {
        // An unverifiable exit keeps the facet tracked until a certified exit or prune.
        this.clearLiveProgramStatusFacet(ptyId)
      }
      if (!isCurrent()) {
        return retirement
      }
      if (processDeathCertified && exitPaneKeys.size > 0) {
        this.reconcileAgentStatusForEndedProcessFn?.(exitPaneKeys)
      }
      if (!isCurrent()) {
        return retirement
      }
      this.clearExitedPtyObservations(ptyId)
      // Natural exits must release Claude leader teams too; explicit-close-only cleanup leaked teams for the runtime lifetime.
      const exitedTeamLeaderHandle = ptyHandle
      if (exitedTeamLeaderHandle) {
        this.claudeAgentTeams.removeTeamForLeaderHandle(exitedTeamLeaderHandle)
      }
      // Queued layout work rechecks missing layout and refuses pty-exited after cleanup.
      this.layouts.delete(ptyId)
      this.layoutQueues.delete(ptyId)
      this.freshSubscribeGuard.delete(ptyId)
      this.cancelPendingDriverMutations(ptyId)
      if (!isCurrent()) {
        return retirement
      }
      // Cold restore can reuse ids during delayed Enter; revoke it before it injects into a replacement.
      this.orchestrationMailboxNotifications.retirePty(ptyId)
      if (!isCurrent()) {
        return retirement
      }
      // Repoint retained handle/pane mailbox pointers away from the retired session.
      for (const { leaf } of leaves) {
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
        if (!isCurrent()) {
          return retirement
        }
        this.notifyFitOverrideListeners(ptyId, 'desktop-fit', 0, 0)
        if (!isCurrent()) {
          return retirement
        }
      }
      // Clear and notify driver state so dead panes cannot retain mobile lock banners.
      this.terminalDrivers.clear(ptyId)
      if (!isCurrent()) {
        return retirement
      }
      this.remoteDesktopFloor.clearPty(ptyId)
      if (!isCurrent()) {
        return retirement
      }
      this.disposeHeadlessTerminal(ptyId)
      if (!isCurrent()) {
        return retirement
      }
      this.trustDialogStatus.forget(ptyId)
      if (!isCurrent()) {
        return retirement
      }
      if (
        !preservesIntentionallyStoppedSurface &&
        !preservesAbnormalSshSurface &&
        options.hostLost !== true
      ) {
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
      try {
        completeExit()
      } finally {
        // The accepted event owns this cohort even if a callback registered a successor.
        if (pty) {
          this.resolvePtyExitWaiters(
            { connected: false, lastExitCode: exitCode, lastExitCause: exitCause },
            waiters
          )
        }
        this.notifyPtyExitListeners(listeners)
      }
    }
    return retirement
  }
}
