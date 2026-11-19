import { OrcaRuntimeWithHandleMobileUnsubscribe } from './mobile-terminal-unsubscribe'

export abstract class OrcaRuntimeWithApplyMobileDisplayMode extends OrcaRuntimeWithHandleMobileUnsubscribe {
  // Apply the most recent actor's viewport and earliest valid restore baseline; return whether no fit override remains, including failed-restore rollback (#7588).
  async applyMobileDisplayMode(ptyId: string): Promise<boolean> {
    const mode = this.getMobileDisplayMode(ptyId)
    const inner = this.mobileSubscribers.get(ptyId)
    const subscriber = inner ? this.pickMostRecentActor(inner) : null
    const subscriberRecord = subscriber && inner ? inner.get(subscriber.clientId) : null

    if (mode === 'desktop') {
      // Clear fitted flags for future auto toggles, but retain them for rollback if resize fails.
      const clearedFitSubscribers = inner
        ? [...inner.values()].filter((sub) => sub.wasResizedToPhone)
        : []
      for (const sub of clearedFitSubscribers) {
        sub.wasResizedToPhone = false
      }
      const anyWasResized = clearedFitSubscribers.length > 0
      // Held overrides can outlive all fitted subscriber flags after null-viewport resubscribe; restore from the common baseline resolver (#7588).
      if (anyWasResized || this.terminalFitOverrides.has(ptyId)) {
        const restore = this.resolveDesktopRestoreTarget(ptyId)
        const result = await this.enqueueLayout(ptyId, {
          kind: 'desktop',
          cols: restore.cols,
          rows: restore.rows
        })
        // Failed restore retains the override; re-arm flags so a later finite unsubscribe still schedules restoration (#7588).
        if (!result.ok) {
          for (const sub of clearedFitSubscribers) {
            sub.wasResizedToPhone = true
          }
        }
      } else {
        // Nothing was fitted or held — emit a mode-change resize event so
        // the mobile client still learns the toggle landed.
        const size = this.getTerminalSize(ptyId)
        this.notifyTerminalResize(ptyId, {
          cols: size?.cols ?? 0,
          rows: size?.rows ?? 0,
          displayMode: 'desktop',
          reason: 'mode-change',
          seq: this.layouts.get(ptyId)?.seq
        })
      }
    } else {
      // Auto fits only a measured subscriber that has not yet been fitted.
      if (subscriberRecord && !subscriberRecord.wasResizedToPhone) {
        const viewport = subscriberRecord.viewport
        if (viewport) {
          await this.handleMobileSubscribe(ptyId, subscriberRecord.clientId, viewport)
          // Report the same no-held-override postcondition for auto mode too.
          return !this.terminalFitOverrides.has(ptyId)
        }
      }
      // Publish mode changes even at identical geometry, carrying current seq for mobile stale-event filtering.
      const size = this.getTerminalSize(ptyId)
      this.notifyTerminalResize(ptyId, {
        cols: size?.cols ?? 0,
        rows: size?.rows ?? 0,
        displayMode: 'auto',
        reason: 'mode-change',
        seq: this.layouts.get(ptyId)?.seq
      })
    }
    return !this.terminalFitOverrides.has(ptyId)
  }

  // Mirror accepted external PTY geometry so hidden-output restore parses at the same width.
  onExternalPtyResize(ptyId: string, cols: number, rows: number): void {
    // The pty:resize IPC handler is supposed to gate via `isResizeSuppressed`
    // before calling here, but defend against callers that don't.
    if (this.isResizeSuppressed()) {
      return
    }
    // Ignore exact phone-fit echoes so they cannot replace desktop baselines; differing fresh pane measurements remain valid.
    const activeOverride = this.terminalFitOverrides.get(ptyId)
    if (activeOverride && activeOverride.cols === cols && activeOverride.rows === rows) {
      return
    }
    // Why: a successful host resize supersedes any target retained after a
    // failed viewer reclaim; a later viewer cycle must capture this new truth.
    this.remoteDesktopFloor.clearStaleHostReclaimTarget(ptyId)
    this.resizeHeadlessTerminal(ptyId, cols, rows)
    this.notePaneGrid(ptyId, cols, rows)
    this.refreshRendererGeometry(ptyId, cols, rows)
  }

  // Fresh pane measurements update restore baselines without resizing, bypassing cascade suppression and override-echo filtering (docs/mobile-fit-hold.md).
  recordRendererGeometry(ptyId: string, cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) {
      return
    }
    // Trusted pane measurements must also update deferred host reclaim targets after a viewer leaves during phone-fit.
    this.remoteDesktopFloor.updateHostReclaimTarget(ptyId, cols, rows)
    this.refreshRendererGeometry(ptyId, cols, rows)
  }

  protected refreshRendererGeometry(ptyId: string, cols: number, rows: number): void {
    this.lastRendererSizes.set(ptyId, { cols, rows })
    const inner = this.mobileSubscribers.get(ptyId)
    if (!inner) {
      return
    }
    // Update only existing baselines; peer subscribers that joined after phone-fit retain null.
    for (const sub of inner.values()) {
      if (sub.previousCols != null && sub.previousRows != null) {
        sub.previousCols = cols
        sub.previousRows = rows
      }
    }
  }

  // Suppress collateral renderer safeFit reports during the post-notification window.
  isResizeSuppressed(): boolean {
    return Date.now() < this.resizeSuppressedUntil
  }

  protected suppressResizesForMs(ms: number): void {
    this.resizeSuppressedUntil = Date.now() + ms
  }
}
