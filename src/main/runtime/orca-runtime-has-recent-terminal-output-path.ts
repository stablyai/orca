// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithGetOrchestrationDispatchAuthority } from './orca-runtime-get-orchestration-dispatch-authority'
import {
  recentTerminalOutputIncludesPath,
  recentTerminalPathCandidatesIncludePath
} from './terminal-output-path-candidates'
import type { ApplyLayoutResult, DriverState } from './orca-runtime-core'
import { clampTerminalViewport } from './terminal-viewport'

export class OrcaRuntimeWithHasRecentTerminalOutputPath extends OrcaRuntimeWithGetOrchestrationDispatchAuthority {
  hasRecentTerminalOutputPath(handle: string, pathText: string, absolutePath: string): boolean {
    // Why: safety net for any query path that never saw a mobile onReady —
    // lazily backfill so the answer matches pre-gate behavior.
    if (!this.recentPtyPathCandidateTrackingActive) {
      this.activateRecentPtyPathCandidateTracking()
    }
    const ptyId = this.resolveLeafForHandle(handle)?.ptyId
    const recentOutput = ptyId ? this.recentPtyOutputById.get(ptyId)?.read() : null
    if (recentOutput && recentTerminalOutputIncludesPath(recentOutput, pathText, absolutePath)) {
      return true
    }
    const candidates = ptyId ? this.recentPtyPathCandidatesById.get(ptyId) : null
    return candidates
      ? recentTerminalPathCandidatesIncludePath(candidates, pathText, absolutePath)
      : false
  }

  // ─── Mobile Fit Override Management ─────────────────────────

  // Why: legacy mobile RPC entrypoint. After the state-machine rewrite this
  // is a thin shim that computes a `PtyLayoutTarget` and routes through
  // `enqueueLayout`. Keeps the same observable return shape so older mobile
  // builds continue to work. See docs/mobile-terminal-layout-state-machine.md.
  async resizeForClient(
    ptyId: string,
    mode: 'mobile-fit' | 'restore',
    clientId: string,
    cols?: number,
    rows?: number
  ): Promise<{
    cols: number
    rows: number
    previousCols: number | null
    previousRows: number | null
    mode: 'mobile-fit' | 'desktop-fit'
  }> {
    if (mode === 'mobile-fit') {
      if (cols == null || rows == null || !Number.isFinite(cols) || !Number.isFinite(rows)) {
        throw new Error('invalid_dimensions')
      }
      const { cols: clampedCols, rows: clampedRows } = clampTerminalViewport(cols, rows)

      const currentSize = this.getTerminalSize(ptyId)
      const existing = this.terminalFitOverrides.get(ptyId)
      // Capture baseline cols/rows for the return value (existing override's
      // baseline wins over current size to preserve original desktop dims
      // across multiple re-fits).
      const previousCols = existing?.previousCols ?? currentSize?.cols ?? null
      const previousRows = existing?.previousRows ?? currentSize?.rows ?? null

      // Why: legacy resizeForClient callers bypass handleMobileSubscribe, so
      // mobileSubscribers stays empty and resolveDesktopRestoreTarget's step-1
      // (per-subscriber baseline) never matches. Stash the pre-fit PTY size
      // into lastRendererSizes so restore lands on step 2 (renderer geometry)
      // instead of step 3 (current phone-fit dims = no-op restore).
      if (currentSize && !existing) {
        this.lastRendererSizes.set(ptyId, {
          cols: currentSize.cols,
          rows: currentSize.rows
        })
      }

      this.freshSubscribeGuard.add(ptyId)
      let result: ApplyLayoutResult
      try {
        result = await this.enqueueLayout(ptyId, {
          kind: 'phone',
          cols: clampedCols,
          rows: clampedRows,
          ownerClientId: clientId
        })
      } finally {
        this.freshSubscribeGuard.delete(ptyId)
      }
      if (!result.ok) {
        throw new Error('resize_failed')
      }

      // Why: mobile-fit via resizeForClient is a deliberate mobile action;
      // the actor takes the floor (updates lastActedAt; mode-flip case is
      // already handled by enqueueLayout above).
      await this.mobileTookFloor(ptyId, clientId)

      return {
        cols: clampedCols,
        rows: clampedRows,
        previousCols,
        previousRows,
        mode: 'mobile-fit'
      }
    }

    // restore mode
    const override = this.terminalFitOverrides.get(ptyId)
    if (!override) {
      throw new Error('no_active_override')
    }
    // Only the owning client can restore — prevents one phone from undoing
    // another phone's active fit.
    if (override.clientId !== clientId) {
      throw new Error('not_override_owner')
    }

    const restore = this.resolveDesktopRestoreTarget(ptyId)
    const result = await this.enqueueLayout(ptyId, {
      kind: 'desktop',
      cols: restore.cols,
      rows: restore.rows
    })
    if (!result.ok) {
      throw new Error('resize_failed')
    }

    // Why: legacy mobile clients on the resizeForClient path also need a
    // fit-override-listener notification (the renderer-side terminalFitOverrideChanged
    // is already emitted by applyLayout's mode-flip path).
    this.notifyFitOverrideListeners(ptyId, 'desktop-fit', restore.cols, restore.rows)

    return {
      cols: restore.cols,
      rows: restore.rows,
      previousCols: null,
      previousRows: null,
      mode: 'desktop-fit'
    }
  }

  getTerminalFitOverride(ptyId: string) {
    return this.terminalFitOverrides.get(ptyId) ?? null
  }

  getAllTerminalFitOverrides(): Map<
    string,
    { mode: 'mobile-fit' | 'remote-desktop-fit'; cols: number; rows: number }
  > {
    const result = new Map<
      string,
      { mode: 'mobile-fit' | 'remote-desktop-fit'; cols: number; rows: number }
    >()
    for (const [ptyId, override] of this.terminalFitOverrides) {
      result.set(ptyId, { mode: override.mode, cols: override.cols, rows: override.rows })
    }
    for (const ptyId of this.remoteDesktopFloor.ownerPtyIds()) {
      if (result.has(ptyId)) {
        continue
      }
      const size = this.getTerminalSize(ptyId)
      if (size) {
        result.set(ptyId, { mode: 'remote-desktop-fit', ...size })
      }
    }
    return result
  }

  getAllTerminalDrivers(): Map<string, DriverState> {
    return this.terminalDrivers.getAll()
  }

  getBrowserRemoteViewerPages(): string[] {
    return this.edgeCommands.getBrowserRemoteViewerPages()
  }
}
