import { OrcaRuntimeWithMobileTookFloor } from './mobile-terminal-activity'
import {
  MOBILE_AUTO_RESTORE_FIT_MAX_MS,
  MOBILE_AUTO_RESTORE_FIT_MIN_MS
} from '../../orca-runtime-postlude'

export abstract class OrcaRuntimeWithReclaimTerminalForDesktop extends OrcaRuntimeWithMobileTookFloor {
  abstract isMobileSubscriberActive(ptyId: string): boolean
  abstract setMobileDisplayMode(ptyId: string, mode: 'auto' | 'desktop'): void

  // Explicit take-back always releases locks/banners, even if resize fails; desktop refits later.
  // Keep desktop mode across automatic phone resubscribe; only a deliberate phone gesture reclaims it (#28487, docs/mobile-fit-hold.md).
  async reclaimTerminalForDesktop(ptyId: string): Promise<boolean> {
    this.cancelPendingDriverMutations(ptyId)
    if (this.isMobileSubscriberActive(ptyId)) {
      this.setMobileDisplayMode(ptyId, 'desktop')
      await this.applyMobileDisplayMode(ptyId)
      this.releaseDesktopTakeBack(ptyId)
      if (this.remoteDesktopFloor.hasLayoutState(ptyId)) {
        await this.applyRemoteDesktopLayout(ptyId)
      }
      return true
    }
    const heldOverride = this.terminalFitOverrides.get(ptyId)
    if (heldOverride && this.remoteDesktopFloor.hasLayoutState(ptyId)) {
      const pending = this.pendingRestoreTimers.get(ptyId)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingRestoreTimers.delete(ptyId)
      }
      const softLeaver = this.pendingSoftLeavers.get(ptyId)
      if (softLeaver) {
        clearTimeout(softLeaver.timer)
        this.pendingSoftLeavers.delete(ptyId)
      }
      this.setDriver(ptyId, { kind: 'idle' })
      this.setMobileDisplayMode(ptyId, 'desktop')
      const converged = await this.applyRemoteDesktopLayout(ptyId)
      if (!converged) {
        // Explicit take-back always clears the lock; resize convergence is
        // best-effort and the desktop renderer will retry on its next frame.
        this.releaseDesktopTakeBack(ptyId)
        return true
      }
      this.setDriver(ptyId, { kind: 'desktop' })
      return true
    }
    if (heldOverride) {
      // Without subscribers, current PTY size may be phone-fit; prefer renderer measurement, then the held pre-fit baseline.
      const fallback = this.resolveDesktopRestoreTarget(ptyId)
      const renderer = this.lastRendererSizes.get(ptyId)
      const cols = renderer?.cols ?? heldOverride.previousCols ?? fallback.cols
      const rows = renderer?.rows ?? heldOverride.previousRows ?? fallback.rows
      // Why: set before the await so a resubscribe landing mid-resize reads 'desktop' and stays passive.
      this.setMobileDisplayMode(ptyId, 'desktop')
      await this.enqueueLayout(ptyId, { kind: 'desktop', cols, rows })
      this.releaseDesktopTakeBack(ptyId)
      return true
    }
    // A mobile driver without subscribers or override is a stale lock; release without resizing.
    if (this.getDriver(ptyId).kind === 'mobile') {
      this.releaseDesktopTakeBack(ptyId)
      this.setMobileDisplayMode(ptyId, 'desktop')
      return true
    }
    return false
  }

  // Reclaim/teardown revoke delayed mobile mutations and soft-leave input-floor admission.
  protected cancelPendingDriverMutations(ptyId: string): void {
    const pendingRestore = this.pendingRestoreTimers.get(ptyId)
    if (pendingRestore) {
      clearTimeout(pendingRestore.timer)
      this.pendingRestoreTimers.delete(ptyId)
    }
    const pendingSoft = this.pendingSoftLeavers.get(ptyId)
    if (pendingSoft) {
      clearTimeout(pendingSoft.timer)
      this.pendingSoftLeavers.delete(ptyId)
    }
  }

  // Explicit take-back clears both lock and held-fit banners now; a failed resize clears optimistically with desktop-fit 0x0 and refits next frame.
  protected releaseDesktopTakeBack(ptyId: string): void {
    this.setDriver(ptyId, { kind: 'desktop' })
    if (this.terminalFitOverrides.has(ptyId)) {
      this.terminalFitOverrides.delete(ptyId)
      this.notifier?.terminalFitOverrideChanged(ptyId, 'desktop-fit', 0, 0)
      this.notifyFitOverrideListeners(ptyId, 'desktop-fit', 0, 0)
    }
  }

  // Null holds indefinitely; clamp finite persisted values to useful bounds (docs/mobile-fit-hold.md).
  protected getAutoRestoreFitMs(): number | null {
    const raw = this.store?.getSettings().mobileAutoRestoreFitMs ?? null
    if (raw == null) {
      return null
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return null
    }
    return Math.min(Math.max(raw, MOBILE_AUTO_RESTORE_FIT_MIN_MS), MOBILE_AUTO_RESTORE_FIT_MAX_MS)
  }

  // Switching to indefinite hold cancels pending restores for every PTY.
  cancelAllPendingFitRestoreTimers(): void {
    for (const [, entry] of this.pendingRestoreTimers) {
      clearTimeout(entry.timer)
    }
    this.pendingRestoreTimers.clear()
  }

  // Expose the same clamped persisted preference to mobile and desktop callers.
  getMobileAutoRestoreFitMs(): number | null {
    return this.getAutoRestoreFitMs()
  }

  // Indefinite mode cancels pending timers; finite changes apply only to the next unsubscribe, avoiding surprise restores of already-held terminals.
  setMobileAutoRestoreFitMs(ms: number | null): number | null {
    if (!this.store?.updateSettings) {
      return this.getAutoRestoreFitMs()
    }
    let normalized: number | null
    if (ms == null) {
      normalized = null
    } else if (typeof ms !== 'number' || !Number.isFinite(ms)) {
      normalized = null
    } else {
      normalized = Math.min(
        Math.max(ms, MOBILE_AUTO_RESTORE_FIT_MIN_MS),
        MOBILE_AUTO_RESTORE_FIT_MAX_MS
      )
    }
    this.store.updateSettings({ mobileAutoRestoreFitMs: normalized }, { notifyListeners: true })
    if (normalized == null) {
      this.cancelAllPendingFitRestoreTimers()
    }
    return normalized
  }
}
