// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithPickMostRecentActor } from './orca-runtime-pick-most-recent-actor'
import type { ApplyLayoutResult, PtyLayoutState, PtyLayoutTarget } from './orca-runtime-core'

export class OrcaRuntimeWithApplyLayout extends OrcaRuntimeWithPickMostRecentActor {
  protected async applyLayout(ptyId: string, target: PtyLayoutTarget): Promise<ApplyLayoutResult> {
    // Why: re-check pty-exit at the head of the slot — the queue may have
    // accepted this target before onPtyExit ran.
    if (!this.layouts.has(ptyId) && !this.isFreshSubscribe(ptyId)) {
      return { ok: false, reason: 'pty-exited' }
    }

    const prev = this.layouts.get(ptyId) ?? null
    const seq = (prev?.seq ?? 0) + 1
    const next: PtyLayoutState = { ...target, seq, appliedAt: Date.now() }

    const currentSize = this.getTerminalSize(ptyId)
    const dimsChanged = currentSize?.cols !== target.cols || currentSize?.rows !== target.rows
    const modeChanged = (prev?.kind ?? 'desktop') !== target.kind

    // Snapshot for rollback.
    const prevFitOverride = this.terminalFitOverrides.get(ptyId) ?? null

    // Tentative writes — the resize is the point of no return.
    this.layouts.set(ptyId, next)
    if (target.kind === 'phone') {
      // Why: pull baseline cols+rows atomically from the same subscriber so
      // they can't desync.
      const baseline = (() => {
        const inner = this.mobileSubscribers.get(ptyId)
        if (!inner) {
          return null
        }
        return this.pickEarliestRestoreTarget(inner)
      })()
      this.terminalFitOverrides.set(ptyId, {
        mode: 'mobile-fit',
        cols: target.cols,
        rows: target.rows,
        previousCols: baseline?.previousCols ?? null,
        previousRows: baseline?.previousRows ?? null,
        updatedAt: next.appliedAt,
        clientId: target.ownerClientId
      })
    } else {
      this.terminalFitOverrides.delete(ptyId)
    }

    if (dimsChanged) {
      let ok = false
      try {
        const r = this.ptyController?.resize?.(ptyId, target.cols, target.rows)
        ok = r ?? true
      } catch (err) {
        console.error('[layout] ptyController.resize threw', { ptyId, err })
        ok = false
      }
      if (!ok) {
        // Roll back to pre-call snapshot. seq is NOT bumped on the wire
        // because we never emit below.
        if (prev) {
          this.layouts.set(ptyId, prev)
        } else {
          this.layouts.delete(ptyId)
        }
        if (prevFitOverride) {
          this.terminalFitOverrides.set(ptyId, prevFitOverride)
        } else {
          this.terminalFitOverrides.delete(ptyId)
        }
        return { ok: false, reason: 'resize-failed' }
      }
      this.resizeHeadlessTerminal(ptyId, target.cols, target.rows)
    }

    // Why: remote desktop ownership is a fit hold for the host and passive
    // peer viewers. Emit every remote layout so owner changes at equal geometry
    // still park/release the correct clients without relying on resize deltas.
    // Defense-in-depth (#7588): also emit when the override's presence
    // changed even without a kind flip. applyLayout is the sole writer and
    // keeps override presence in lockstep with layout kind, so overrideChanged
    // ≡ modeChanged in every reachable state today; the extra clause fires
    // only if that invariant is ever violated, repairing the renderer instead
    // of stranding the held modal.
    const overrideChanged = (prevFitOverride != null) !== (target.kind === 'phone')
    if (target.kind === 'remote-desktop' || modeChanged || overrideChanged) {
      // Why: phone→desktop arms the renderer-cascade suppress window
      // before the collateral safeFit IPCs arrive. See "Renderer cascade
      // suppression".
      if (target.kind === 'desktop') {
        this.lastRendererSizes.delete(ptyId)
        this.suppressResizesForMs(500)
      }
      this.notifier?.terminalFitOverrideChanged(
        ptyId,
        target.kind === 'phone'
          ? 'mobile-fit'
          : target.kind === 'remote-desktop'
            ? 'remote-desktop-fit'
            : 'desktop-fit',
        target.cols,
        target.rows
      )
      this.notifyFitOverrideListeners(
        ptyId,
        target.kind === 'phone'
          ? 'mobile-fit'
          : target.kind === 'remote-desktop'
            ? 'remote-desktop-fit'
            : 'desktop-fit',
        target.cols,
        target.rows
      )
    }

    // Mobile-facing event always fires (phone clients need to re-fit on
    // every dim change, not just mode flips).
    this.notifyTerminalResize(ptyId, {
      cols: target.cols,
      rows: target.rows,
      displayMode: target.kind === 'phone' ? 'phone' : 'desktop',
      reason: 'apply-layout',
      seq
    })

    return { ok: true, state: next }
  }

  // ─── Server-Authoritative Mobile Display Mode ─────────────────────

  setMobileDisplayMode(ptyId: string, mode: 'auto' | 'desktop'): void {
    if (mode === 'auto') {
      this.mobileDisplayModes.delete(ptyId)
    } else {
      this.mobileDisplayModes.set(ptyId, mode)
    }
  }

  getMobileDisplayMode(ptyId: string): 'auto' | 'desktop' {
    return this.mobileDisplayModes.get(ptyId) ?? 'auto'
  }

  isMobileSubscriberActive(ptyId: string): boolean {
    const inner = this.mobileSubscribers.get(ptyId)
    return inner !== undefined && inner.size > 0
  }

  // Why: late-bind viewport on an existing subscriber record. Subscribers
  // that registered before the mobile side measured (e.g. terminal first
  // mounted while the WebView was still loading) have null viewport, and
  // applyMobileDisplayMode's auto branch needs a viewport to phone-fit.
  // The setDisplayMode RPC carries the latest viewport so we can patch it
  // here just before applyMobileDisplayMode runs.
  updateMobileSubscriberViewport(
    ptyId: string,
    clientId: string,
    viewport: { cols: number; rows: number }
  ): void {
    const inner = this.mobileSubscribers.get(ptyId)
    const record = inner?.get(clientId)
    if (!record) {
      return
    }
    record.viewport = viewport
  }
}
