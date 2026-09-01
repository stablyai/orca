// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithMarkPtyLivenessUnverifiable } from './orca-runtime-mark-pty-liveness-unverifiable'
import type { ApplyLayoutResult, DriverState } from './orca-runtime-core'
import { clampTerminalViewport } from './terminal-viewport'

export class OrcaRuntimeWithMobileTookFloor extends OrcaRuntimeWithMarkPtyLivenessUnverifiable {
  // Why: invoked from mobile RPC method handlers (terminal.send / setDisplayMode /
  // resizeForClient / fresh subscribe with auto). Records the actor as the
  // most recent mobile driver and re-applies phone-fit if we were previously
  // in `desktop` mode (mobile reclaims a take-back). Mobile-to-mobile hand-offs
  // are no-ops for resize.
  async mobileTookFloor(
    ptyId: string,
    clientId: string,
    previousFloor?: DriverState,
    isCurrent: () => boolean = () => true
  ): Promise<void> {
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
    // Why: a deliberate mobile action implies mobile is resuming control.
    // If the display mode is currently 'desktop' (set by an earlier
    // take-back), flip it back to 'auto' (= map absence) and re-apply so
    // phone-fit takes hold again. See docs/mobile-presence-lock.md.
    if (prev.kind === 'desktop' || currentMode === 'desktop') {
      if (currentMode === 'desktop') {
        this.mobileDisplayModes.delete(ptyId)
      }
      await this.applyMobileDisplayMode(ptyId)
    }
    // Why: display changes are async; a later PTY write must keep the floor
    // when an older phone-fit operation eventually completes.
    if (!isCurrent()) {
      return
    }
    this.setDriver(ptyId, { kind: 'mobile', clientId })
  }

  // Why: in-place viewport update on the existing mobile subscription —
  // used when the mobile keyboard opens/closes and shrinks/grows the
  // visible terminal area. We refresh the subscriber's viewport, re-fit
  // the PTY to the new dims, and emit a 'resized' event so the mobile
  // xterm reinits inline at the new dims without re-subscribing. This
  // avoids the unsubscribe → resubscribe cycle which would (a) flash the
  // desktop lock banner during the brief idle gap and (b) cause the new
  // subscribe to capture the already-phone-fitted PTY size as its
  // restore baseline (stuck-dim bug on later disconnect).
  // No-op when the client isn't actually subscribed to this PTY.
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
    // The driver is already mobile{this client} when we got here; refresh
    // to update lastActedAt-based ordering on later actor selection.
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
