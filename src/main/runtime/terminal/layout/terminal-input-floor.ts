import { OrcaRuntimeWithOnPtyExit } from '../lifecycle/pty-exit-lifecycle'
import type { PtyLivenessVerdict } from '../../../../shared/pty-liveness-verdict'
import type { DriverState } from '../../orca-runtime-core'
import { isDrivingInputKind, type TerminalInputKind } from '../../../../shared/terminal-input-kind'
import { isUntypedTerminalInput } from '../../../../shared/terminal-untyped-input'
import { clampTerminalViewport } from '../../../../shared/terminal-viewport'
import { getPtyTerminalState, getTerminalState } from '../../terminal-wait-results'

// Orphaned verdicts are bounded; active PTYs retain theirs until new evidence resolves them.
const MAX_TRACKED_PTY_LIVENESS_VERDICTS = 256

export abstract class OrcaRuntimeWithMarkPtyLivenessUnverifiable extends OrcaRuntimeWithOnPtyExit {
  protected abstract leafExistsForPty(ptyId: string): boolean
  abstract recordRendererGeometry(ptyId: string, cols: number, rows: number): void
  abstract isResizeSuppressed(): boolean
  protected abstract refreshRendererGeometry(ptyId: string, cols: number, rows: number): void

  /** Lost host contact never proves exit; detached relay PTYs outlive their provider. */
  markPtyLivenessUnverifiable(ptyId: string, reason: string): void {
    this.rememberPtyLivenessVerdict(ptyId, { status: 'unverifiable', reason })
  }

  /** Fence positive host observations by sequence so slow inventory cannot overwrite newer lost-contact evidence. */
  markPtyLivenessLive(ptyId: string, observedNoLaterThan?: number): void {
    const tracked = this.ptyLivenessVerdictByPtyId.get(ptyId)
    if (observedNoLaterThan !== undefined && tracked && tracked.observedAt > observedNoLaterThan) {
      return
    }
    if (tracked?.verdict.status === 'unverifiable') {
      void this.recheckHookAgentPresenceForPty(ptyId)
    }
    this.rememberPtyLivenessVerdict(ptyId, { status: 'live', ptyIds: [ptyId] })
  }

  /** Record stop intent before killing: provider exit codes cannot distinguish operator closes from agent death (STA-4603). */
  markPtyStopRequested(ptyId: string): void {
    this.stopRequestedPtyIds.add(ptyId)
  }

  /** A stop that failed or was refused: the PTY runs on, so nothing may read it as closing. */
  clearPtyStopRequest(ptyId: string): void {
    this.stopRequestedPtyIds.delete(ptyId)
  }

  isPtyStopRequested(ptyId: string): boolean {
    return this.stopRequestedPtyIds.has(ptyId)
  }

  /** Null means no defensible claim, never proof of death. Kill authorization fails closed; recovery instead refuses positive live/unverifiable verdicts. */
  getPtyLivenessVerdict(ptyId: string): PtyLivenessVerdict | null {
    return this.ptyLivenessVerdictByPtyId.get(ptyId)?.verdict ?? null
  }

  protected isPtyKnownExited(ptyId: string): boolean {
    const pty = this.ptysById.get(ptyId)
    if (pty) {
      // Disconnected can mean dropped relay contact; only exited state ends watching.
      return getPtyTerminalState(pty) === 'exited'
    }
    // Graph leaves can outlive or precede PTY records; consult both so dead-terminal waits cannot hang.
    return this.getLeavesForPty(ptyId).some((leaf) => getTerminalState(leaf) === 'exited')
  }

  subscribeToPtyExit(ptyId: string, listener: () => void): () => void {
    const lifecycleGeneration = this.getPtyLifecycleGeneration(ptyId)
    if (this.isPtyKnownExited(ptyId)) {
      listener()
      return () => {}
    }
    let listeners = this.ptyExitListenersByPtyId.get(ptyId)
    if (!listeners) {
      listeners = new Set()
      this.ptyExitListenersByPtyId.set(ptyId, listeners)
    }
    let active = true
    const unsubscribe = (): void => {
      if (!active) {
        return
      }
      active = false
      listeners!.delete(listener)
      if (listeners!.size === 0 && this.ptyExitListenersByPtyId.get(ptyId) === listeners) {
        this.ptyExitListenersByPtyId.delete(ptyId)
      }
    }
    listeners.add(listener)
    if (
      this.getPtyLifecycleGeneration(ptyId) !== lifecycleGeneration ||
      this.isPtyKnownExited(ptyId)
    ) {
      unsubscribe()
      listener()
    }
    return unsubscribe
  }

  /** Resolves once a registered PTY's exit reaches its runtime record; false on timeout. */
  waitForPtyExitRecord(ptyId: string, timeoutMs: number): Promise<boolean> {
    if (!this.ptysById.has(ptyId) || this.isPtyKnownExited(ptyId)) {
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      let unsubscribe = (): void => {}
      const timer = setTimeout(
        () => {
          unsubscribe()
          resolve(false)
        },
        Math.max(0, timeoutMs)
      )
      timer.unref?.()
      unsubscribe = this.subscribeToPtyExit(ptyId, () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  protected rememberPtyLivenessVerdict(ptyId: string, verdict: PtyLivenessVerdict): void {
    // Retain certified exits against weak observations; only host-delivered exit evidence may establish exited (docs/reference/ssh-execution-boundary.md).
    this.ptyLivenessVerdictByPtyId.delete(ptyId)
    this.ptyLivenessObservationSequence += 1
    this.ptyLivenessVerdictByPtyId.set(ptyId, {
      verdict,
      observedAt: this.ptyLivenessObservationSequence
    })
    while (this.ptyLivenessVerdictByPtyId.size > MAX_TRACKED_PTY_LIVENESS_VERDICTS) {
      let oldestOrphaned: string | null = null
      for (const candidate of this.ptyLivenessVerdictByPtyId.keys()) {
        if (
          !this.ptysById.has(candidate) &&
          !this.handleByPtyId.has(candidate) &&
          !this.leafExistsForPty(candidate)
        ) {
          oldestOrphaned = candidate
          break
        }
      }
      if (!oldestOrphaned) {
        return
      }
      this.ptyLivenessVerdictByPtyId.delete(oldestOrphaned)
    }
  }

  protected forgetPtyLivenessVerdict(ptyId: string, observedNoLaterThan?: number): void {
    const tracked = this.ptyLivenessVerdictByPtyId.get(ptyId)
    // An inventory's weak absence cannot revoke an earlier host-certified exit.
    if (tracked?.verdict.status === 'exited') {
      return
    }
    if (observedNoLaterThan !== undefined && tracked && tracked.observedAt > observedNoLaterThan) {
      return
    }
    this.ptyLivenessVerdictByPtyId.delete(ptyId)
  }

  getDriver(ptyId: string): DriverState {
    return this.terminalDrivers.get(ptyId)
  }

  protected setDriver(ptyId: string, next: DriverState): void {
    this.terminalDrivers.set(ptyId, next)
  }

  // Phones and remote desktop viewers suppress host resize. Desktop viewers still share input and use a separate registry from mobile locks.
  isPtyResizeDrivenRemotely(ptyId: string): boolean {
    if (this.getDriver(ptyId).kind === 'mobile') {
      return true
    }
    return this.isRemoteDesktopResizeDriven(ptyId)
  }

  isRemoteDesktopResizeDriven(ptyId: string): boolean {
    return this.remoteDesktopFloor.isResizeDriven(ptyId)
  }

  isRemoteDesktopViewerOwner(ptyId: string, subscriptionKey: string): boolean {
    return this.remoteDesktopFloor.isViewerOwner(ptyId, subscriptionKey)
  }

  getRemoteDesktopFitHold(
    ptyId: string,
    subscriptionKey: string
  ): { mode: 'remote-desktop-fit' | 'desktop-fit'; cols: number; rows: number } {
    return this.remoteDesktopFloor.getFitHold(ptyId, subscriptionKey)
  }

  recordRemoteDesktopHostReclaimTarget(ptyId: string, cols: number, rows: number): void {
    this.remoteDesktopFloor.recordHostReclaimTarget(ptyId, cols, rows)
  }

  async applyRemoteDesktopLayout(ptyId: string): Promise<boolean> {
    return this.remoteDesktopFloor.applyLayout(ptyId)
  }

  // Why: attachment only records geometry. Passive hydration/reconnect must not
  // steal the shared PTY from the desktop where the user is actively working.
  async updateRemoteDesktopViewer(
    ptyId: string,
    subscriptionKey: string,
    clientId: string,
    cols: number,
    rows: number,
    claim = true
  ): Promise<boolean> {
    return this.remoteDesktopFloor.updateViewer(ptyId, subscriptionKey, clientId, cols, rows, claim)
  }

  claimRemoteDesktopViewer(ptyId: string, subscriptionKey: string): Promise<boolean> {
    return this.remoteDesktopFloor.claimViewer(ptyId, subscriptionKey)
  }

  claimRemoteDesktopHost(ptyId: string, cols: number, rows: number): Promise<boolean> {
    return this.remoteDesktopFloor.claimHost(ptyId, cols, rows)
  }

  noteRemoteDesktopHostInput(ptyId: string, inputKind: TerminalInputKind, data: string): void {
    if (isDrivingInputKind(inputKind) && !isUntypedTerminalInput(data)) {
      this.remoteDesktopFloor.noteHostInput(ptyId)
    }
  }

  unregisterRemoteDesktopViewer(ptyId: string, subscriptionKey: string): Promise<boolean> {
    return this.unregisterRemoteDesktopViewers(ptyId, [subscriptionKey])
  }

  unregisterRemoteDesktopViewers(
    ptyId: string,
    subscriptionKeys: Iterable<string>
  ): Promise<boolean> {
    return this.remoteDesktopFloor.unregisterViewers(ptyId, subscriptionKeys)
  }

  // One-shot viewport RPCs have no disconnect cleanup; refresh only stream-owned floors or host width would remain pinned after departure.
  refreshRemoteDesktopViewer(
    ptyId: string,
    clientId: string,
    cols: number,
    rows: number,
    claim = false
  ): Promise<boolean> {
    return this.remoteDesktopFloor.refreshViewer(ptyId, clientId, cols, rows, claim)
  }

  async updateDesktopViewport(
    ptyId: string,
    viewport: { cols: number; rows: number }
  ): Promise<boolean> {
    const { cols, rows } = clampTerminalViewport(viewport.cols, viewport.rows)
    if (this.terminalFitOverrides.has(ptyId) || this.getDriver(ptyId).kind === 'mobile') {
      this.recordRendererGeometry(ptyId, cols, rows)
      return true
    }
    if (this.isResizeSuppressed()) {
      return false
    }
    this.freshSubscribeGuard.add(ptyId)
    try {
      const result = await this.enqueueLayout(ptyId, { kind: 'desktop', cols, rows })
      if (result.ok) {
        this.refreshRendererGeometry(ptyId, cols, rows)
      }
      return result.ok
    } finally {
      this.freshSubscribeGuard.delete(ptyId)
    }
  }

  markMobileActor(ptyId: string, clientId: string): void {
    const inner = this.mobileSubscribers.get(ptyId)
    const sub = inner?.get(clientId)
    if (sub) {
      sub.lastActedAt = Date.now()
    }
    this.setDriver(ptyId, { kind: 'mobile', clientId })
  }

  beginMobileInputFloor(
    ptyId: string,
    clientId: string
  ): { commit: () => Promise<void>; rollback: () => void } | null {
    return this.terminalDrivers.beginMobileInputFloor(ptyId, clientId)
  }
}
