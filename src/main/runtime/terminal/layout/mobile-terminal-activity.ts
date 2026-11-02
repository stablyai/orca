import { OrcaRuntimeWithMarkPtyLivenessUnverifiable } from './terminal-input-floor'
import type { ApplyLayoutResult, DriverState } from '../../orca-runtime-core'
import { clampTerminalViewport } from '../../../../shared/terminal-viewport'

export abstract class OrcaRuntimeWithMobileTookFloor extends OrcaRuntimeWithMarkPtyLivenessUnverifiable {
  abstract applyMobileDisplayMode(ptyId: string): Promise<boolean>

  // Mobile gestures reclaim desktop take-back and fit the active viewport; mobile-to-mobile handoffs preserve resize.
  async mobileTookFloor(
    ptyId: string,
    clientId: string,
    previousFloor?: DriverState,
    isCurrent?: () => boolean
  ): Promise<void> {
    if (!isCurrent) {
      await this.beginMobileInputFloor(ptyId, clientId)?.commit()
      return
    }
    const inner = this.mobileSubscribers.get(ptyId)
    const sub = inner?.get(clientId)
    const softLeaver = this.pendingSoftLeavers.get(ptyId)
    // Why: native chat pauses terminal output, so its later sends have no
    // subscriber lifecycle that could release a newly-created desktop lock.
    if (!sub && softLeaver?.clientId !== clientId) {
      return
    }
    if (sub) {
      sub.lastActedAt = Date.now()
    }
    const prev = previousFloor ?? this.getDriver(ptyId)
    const currentMode = this.mobileDisplayModes.get(ptyId)
    // A deliberate mobile gesture clears desktop mode so phone-fit can reclaim the PTY (docs/mobile-presence-lock.md).
    if (prev.kind === 'desktop' || currentMode === 'desktop') {
      if (currentMode === 'desktop') {
        this.mobileDisplayModes.delete(ptyId)
      }
      await this.applyMobileDisplayMode(ptyId)
    }
    // Newer input or disconnect can supersede an asynchronous phone-fit.
    if (
      !isCurrent() ||
      (!this.mobileSubscribers.get(ptyId)?.has(clientId) &&
        this.pendingSoftLeavers.get(ptyId)?.clientId !== clientId)
    ) {
      return
    }
    this.setDriver(ptyId, { kind: 'mobile', clientId })
  }

  // Update subscribed viewports inline to avoid banner flashes and recapturing phone-fit restore baselines during resubscribe.
  async updateMobileViewport(
    ptyId: string,
    clientId: string,
    viewport: { cols: number; rows: number }
  ): Promise<{ updated: boolean; applied: boolean }> {
    const inner = this.mobileSubscribers.get(ptyId)
    const sub = inner?.get(clientId)
    if (!sub) {
      return { updated: false, applied: false }
    }
    sub.viewport = viewport
    sub.lastActedAt = Date.now()

    const mode = this.getMobileDisplayMode(ptyId)
    if (mode === 'desktop') {
      // Watching at desktop dims — viewport is informational only.
      return { updated: true, applied: false }
    }
    if (this.getDriver(ptyId).kind === 'desktop') {
      return { updated: true, applied: false }
    }
    // Drive PTY dims by the most-recent-actor (just updated to this client).
    const winner = this.pickMostRecentActor(inner!)
    if (!winner) {
      return { updated: false, applied: false }
    }
    const winnerSub = inner!.get(winner.clientId)
    const driveViewport = winnerSub?.viewport ?? viewport
    const { cols: clampedCols, rows: clampedRows } = clampTerminalViewport(
      driveViewport.cols,
      driveViewport.rows
    )

    sub.wasResizedToPhone = true
    // Refresh the current driver's lastActedAt ordering for later actor selection.
    this.setDriver(ptyId, { kind: 'mobile', clientId })

    const needsFreshSubscribeGuard = !this.layouts.has(ptyId)
    if (needsFreshSubscribeGuard) {
      this.freshSubscribeGuard.add(ptyId)
    }
    let result: ApplyLayoutResult
    try {
      result = await this.enqueueLayout(ptyId, {
        kind: 'phone',
        cols: clampedCols,
        rows: clampedRows,
        ownerClientId: winner.clientId
      })
    } finally {
      if (needsFreshSubscribeGuard) {
        this.freshSubscribeGuard.delete(ptyId)
      }
    }
    return { updated: true, applied: result.ok }
  }
}
