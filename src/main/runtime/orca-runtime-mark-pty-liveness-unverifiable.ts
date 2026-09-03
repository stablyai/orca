// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithOnPtyExit } from './orca-runtime-on-pty-exit'
import type { PtyLivenessVerdict } from '../../shared/pty-liveness-verdict'
import type { DriverState } from './orca-runtime-core'
import { clampTerminalViewport } from './terminal-viewport'
import { getPtyTerminalState, getTerminalState } from './terminal-wait-results'

// Orphaned verdicts are bounded; active PTYs retain theirs until new evidence resolves them.
const MAX_TRACKED_PTY_LIVENESS_VERDICTS = 256

export class OrcaRuntimeWithMarkPtyLivenessUnverifiable extends OrcaRuntimeWithOnPtyExit {
  /**
   * Records that we lost contact with a PTY's owning host. Callers must never
   * read this as an exit: a detached relay PTY is designed to outlive the
   * provider that addressed it.
   */
  markPtyLivenessUnverifiable(ptyId: string, reason: string): void {
    this.rememberPtyLivenessVerdict(ptyId, { status: 'unverifiable', reason })
  }

  markPtyLivenessLive(ptyId: string): void {
    this.rememberPtyLivenessVerdict(ptyId, { status: 'live', ptyIds: [ptyId] })
  }

  /**
   * Records that Orca asked this PTY to stop — a close, a stop, a teardown.
   *
   * Why before the kill and not at the exit: a requested stop can still be
   * delivered by the provider's own exit event, which carries a process status
   * indistinguishable from a natural finish. The intent is the only thing that
   * separates "the operator closed it" from "the agent died", so it is recorded
   * where it is known rather than reconstructed afterwards (STA-4603).
   */
  markPtyStopRequested(ptyId: string): void {
    this.stopRequestedPtyIds.add(ptyId)
  }

  isPtyStopRequested(ptyId: string): boolean {
    return this.stopRequestedPtyIds.has(ptyId)
  }

  /**
   * Null when this register holds no defensible claim — a never-asked host, a fresh app start, or
   * an absence observation too weak to name (a relay that answered but does not know the id: see
   * the inventory sweep and handlePtyReattachFailure). It is NOT a death certificate, so a caller
   * authorizing a kill must fail closed on it; a caller that only has this evidence to work with,
   * like terminal.recoverPane, refuses on the positive verdicts instead.
   */
  getPtyLivenessVerdict(ptyId: string): PtyLivenessVerdict | null {
    return this.ptyLivenessVerdictByPtyId.get(ptyId)?.verdict ?? null
  }

  protected isPtyKnownExited(ptyId: string): boolean {
    const pty = this.ptysById.get(ptyId)
    if (pty) {
      // Why: `!connected` is an inference, not proof. The liveness sweep clears it with no
      // exit code for every PTY of a dropped relay, so reading that as an exit retires the
      // lease of a process still running on the host — 'unknown' must keep watching.
      return getPtyTerminalState(pty) === 'exited'
    }
    // Why: leavesByPtyId is rebuilt from the renderer graph independently of ptysById, so a
    // leaf can outlive (or precede) its pty record; without this an already-dead pty never
    // fires and the caller's release waits forever.
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

  protected rememberPtyLivenessVerdict(ptyId: string, verdict: PtyLivenessVerdict): void {
    // An earned death certificate is KEPT, not dropped, so the register is three-valued on disk as
    // well as in the type. Its only writer is a host-delivered exit frame; nothing weaker may
    // reach it (docs/reference/ssh-execution-boundary.md).
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
    if (observedNoLaterThan !== undefined && tracked && tracked.observedAt > observedNoLaterThan) {
      return
    }
    this.ptyLivenessVerdictByPtyId.delete(ptyId)
  }

  // ─── Driver state (mobile-presence lock) ──────────────────────────
  //
  // See docs/mobile-presence-lock.md.

  getDriver(ptyId: string): DriverState {
    return this.terminalDrivers.get(ptyId)
  }

  protected setDriver(ptyId: string, next: DriverState): void {
    this.terminalDrivers.set(ptyId, next)
  }

  // Why: the host's own fit cascade (window resize, split drag, tab reveal,
  // "+"-new-tab re-render) must not resize a PTY whose width a remote client
  // owns — that is the remote "porridge" bug. True while a phone (mobile driver)
  // OR an active remote desktop viewer owns the PTY. Input is deliberately NOT gated
  // here (see the `writePtyInput` mobile-only checks): shared-control desktop
  // viewers may still type alongside the host.
  // Note: this is intentionally NOT a driver kind. An active remote viewer needs
  // only resize suppression, not the mobile driver machinery (input lock,
  // phone-fit, driver-change banners), so it lives in its own registry and does
  // not perturb the presence-lock state machine. It also coexists with mobile:
  // while a phone drives, the registry still suppresses host resize, and when
  // the phone leaves the surviving viewer keeps the PTY suppressed.
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

  unregisterRemoteDesktopViewer(ptyId: string, subscriptionKey: string): Promise<boolean> {
    return this.unregisterRemoteDesktopViewers(ptyId, [subscriptionKey])
  }

  unregisterRemoteDesktopViewers(
    ptyId: string,
    subscriptionKeys: Iterable<string>
  ): Promise<boolean> {
    return this.remoteDesktopFloor.unregisterViewers(ptyId, subscriptionKeys)
  }

  // Why: the one-shot `terminal.updateViewport` RPC has no disconnect hook, so
  // it must never *create* a width floor (that floor would leak — nothing
  // releases it, pinning the host at a stale width after the viewer is gone).
  // It only refreshes the floor(s) this client already owns via its stream
  // subscription, keyed by clientId. Mirrors the mobile `updateMobileViewport`
  // no-op-without-subscription invariant. Returns false when the client owns no
  // floor (passive/stream-less viewer) — a stream-less viewer must not lock host
  // resize.
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
