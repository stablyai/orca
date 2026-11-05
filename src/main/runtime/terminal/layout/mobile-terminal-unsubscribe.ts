import { OrcaRuntimeWithHandleMobileSubscribeInternal } from './mobile-terminal-subscribe-internal'

export abstract class OrcaRuntimeWithHandleMobileUnsubscribe extends OrcaRuntimeWithHandleMobileSubscribeInternal {
  // Only the last subscriber schedules restore; surviving peers retain the floor and elect their most recent actor. Debounce avoids tab-switch resize thrashing.
  handleMobileUnsubscribe(ptyId: string, clientId: string): void {
    const inner = this.mobileSubscribers.get(ptyId)
    if (!inner) {
      return
    }
    const subscriber = inner.get(clientId)
    if (!subscriber) {
      return
    }
    const wasResizedToPhone = subscriber.wasResizedToPhone

    inner.delete(clientId)
    this.notifyRemoteTerminalViewPresenceChanged(ptyId)

    if (inner.size > 0) {
      // Donate the departing baseline to the earliest surviving subscriber; peer joiners against phone-fit dimensions have none.
      if (
        subscriber.previousCols != null &&
        subscriber.previousRows != null &&
        !this.pickEarliestRestoreTarget(inner)
      ) {
        let earliestSurvivor: { clientId: string; subscribedAt: number } | null = null
        for (const sub of inner.values()) {
          if (earliestSurvivor === null || sub.subscribedAt < earliestSurvivor.subscribedAt) {
            earliestSurvivor = { clientId: sub.clientId, subscribedAt: sub.subscribedAt }
          }
        }
        if (earliestSurvivor) {
          const heir = inner.get(earliestSurvivor.clientId)
          if (heir) {
            heir.previousCols = subscriber.previousCols
            heir.previousRows = subscriber.previousRows
          }
        }
      }
      // Elect the surviving actor when the active phone leaves, keeping banner ownership and viewport aligned.
      const driver = this.getDriver(ptyId)
      if (driver.kind === 'mobile' && driver.clientId === clientId) {
        const next = this.pickMostRecentActor(inner)
        if (next) {
          this.setDriver(ptyId, { kind: 'mobile', clientId: next.clientId })
          // Fire-and-forget — handleMobileUnsubscribe stays sync; applyLayout
          // failures self-recover on the next gesture.
          void this.applyMobileDisplayMode(ptyId)
        }
      }
      return
    }

    this.mobileSubscribers.delete(ptyId)
    const mode = this.getMobileDisplayMode(ptyId)

    // Hold mobile ownership ~250ms to avoid banner flashes on older-client resubscribe (docs/mobile-presence-lock.md).
    const SOFT_LEAVE_GRACE_MS = 250
    const existingSoft = this.pendingSoftLeavers.get(ptyId)
    if (existingSoft) {
      clearTimeout(existingSoft.timer)
      this.pendingSoftLeavers.delete(ptyId)
    }
    const softTimer = setTimeout(() => {
      this.pendingSoftLeavers.delete(ptyId)
      if (!this.mobileSubscribers.has(ptyId)) {
        this.setDriver(ptyId, { kind: 'idle' })
        if (this.remoteDesktopFloor.hasViewers(ptyId)) {
          void this.applyRemoteDesktopLayout(ptyId)
        }
      }
    }, SOFT_LEAVE_GRACE_MS)
    if (typeof softTimer.unref === 'function') {
      softTimer.unref()
    }
    this.pendingSoftLeavers.set(ptyId, {
      clientId,
      timer: softTimer,
      record: {
        clientId: subscriber.clientId,
        viewport: subscriber.viewport,
        wasResizedToPhone: subscriber.wasResizedToPhone,
        previousCols: subscriber.previousCols,
        previousRows: subscriber.previousRows,
        subscribedAt: subscriber.subscribedAt,
        lastActedAt: subscriber.lastActedAt
      }
    })

    if (mode === 'auto' && wasResizedToPhone) {
      const existingTimer = this.pendingRestoreTimers.get(ptyId)
      if (existingTimer) {
        clearTimeout(existingTimer.timer)
        this.pendingRestoreTimers.delete(ptyId)
      }
      // Null auto-restore means hold phone dimensions until explicit desktop Restore; finite values restore after the last unsubscribe (docs/mobile-fit-hold.md).
      const autoRestoreMs = this.getAutoRestoreFitMs()
      if (autoRestoreMs == null) {
        // Indefinite hold retains the fit override while soft-leave grace releases input ownership.
      } else {
        // Snapshot the baseline before subscriber deletion; timer-time fallback could read current phone dimensions.
        const fallback = this.lastRendererSizes.get(ptyId)
        const restoreCols =
          subscriber.previousCols ?? fallback?.cols ?? this.getTerminalSize(ptyId)?.cols ?? 80
        const restoreRows =
          subscriber.previousRows ?? fallback?.rows ?? this.getTerminalSize(ptyId)?.rows ?? 24
        const timer = setTimeout(() => {
          this.pendingRestoreTimers.delete(ptyId)
          if (this.isMobileSubscriberActive(ptyId)) {
            return
          }
          if (this.remoteDesktopFloor.hasLayoutState(ptyId)) {
            void this.applyRemoteDesktopLayout(ptyId)
            return
          }
          void this.enqueueLayout(ptyId, {
            kind: 'desktop',
            cols: restoreCols,
            rows: restoreRows
          })
        }, autoRestoreMs)
        // Pending mobile restores must not keep Electron alive after its windows/transports stop.
        if (typeof timer.unref === 'function') {
          timer.unref()
        }

        this.pendingRestoreTimers.set(ptyId, { timer, clientId })
      }
    }
  }
}
