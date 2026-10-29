import { OrcaRuntimeWithHandleMobileSubscribe } from './mobile-terminal-subscribe'
import { clampTerminalViewport } from '../../../../shared/terminal-viewport'

export abstract class OrcaRuntimeWithHandleMobileSubscribeInternal extends OrcaRuntimeWithHandleMobileSubscribe {
  protected async handleMobileSubscribeInternal(
    ptyId: string,
    clientId: string,
    viewport?: { cols: number; rows: number }
  ): Promise<boolean> {
    const mode = this.getMobileDisplayMode(ptyId)

    // Any new subscriber supersedes the prior client's pending restore.
    const pendingRestore = this.pendingRestoreTimers.get(ptyId)
    if (pendingRestore) {
      clearTimeout(pendingRestore.timer)
      this.pendingRestoreTimers.delete(ptyId)
    }

    // Same-client soft-leave returns retain their original desktop baseline.
    const softLeaver = this.pendingSoftLeavers.get(ptyId)
    if (softLeaver && softLeaver.clientId === clientId) {
      clearTimeout(softLeaver.timer)
      this.pendingSoftLeavers.delete(ptyId)
      let inner = this.mobileSubscribers.get(ptyId)
      if (!inner) {
        inner = new Map()
        this.mobileSubscribers.set(ptyId, inner)
      }
      inner.set(clientId, {
        ...softLeaver.record,
        viewport: viewport ?? null,
        lastActedAt: Date.now()
      })
      if (!viewport) {
        return false
      }
      // Why: an iOS resume resubscribes inside this grace; after a desktop take-back it must stay passive like a fresh subscribe (#28487).
      if (mode !== 'desktop') {
        this.setDriver(ptyId, { kind: 'mobile', clientId })
        const { cols: clampedCols, rows: clampedRows } = clampTerminalViewport(
          viewport.cols,
          viewport.rows
        )
        this.freshSubscribeGuard.add(ptyId)
        try {
          await this.enqueueLayout(ptyId, {
            kind: 'phone',
            cols: clampedCols,
            rows: clampedRows,
            ownerClientId: clientId
          })
        } finally {
          this.freshSubscribeGuard.delete(ptyId)
        }
      }
      return true
    }

    let inner = this.mobileSubscribers.get(ptyId)
    if (!inner) {
      inner = new Map()
      this.mobileSubscribers.set(ptyId, inner)
    }

    // Capture before fitting; peer joiners inherit no baseline. An indefinite hold's override outranks current phone dimensions.
    const heldOverride = this.terminalFitOverrides.get(ptyId)
    const existing = inner.get(clientId)
    const someoneAlreadyFitted = [...inner.values()].some((s) => s.wasResizedToPhone)
    const currentSize = this.getTerminalSize(ptyId)
    const rendererSize = this.lastRendererSizes.get(ptyId)
    const previousCols =
      existing?.previousCols ??
      heldOverride?.previousCols ??
      (someoneAlreadyFitted ? null : (rendererSize?.cols ?? currentSize?.cols ?? null))
    const previousRows =
      existing?.previousRows ??
      heldOverride?.previousRows ??
      (someoneAlreadyFitted ? null : (rendererSize?.rows ?? currentSize?.rows ?? null))
    const now = Date.now()
    const subscribedAt = existing?.subscribedAt ?? now

    if (!viewport) {
      // Unmeasured mobile views retain the subscriber and desktop baseline until a later viewport update.
      inner.set(clientId, {
        clientId,
        viewport: null,
        wasResizedToPhone: false,
        previousCols,
        previousRows,
        subscribedAt,
        lastActedAt: now
      })
      return false
    }

    const { cols: clampedCols, rows: clampedRows } = clampTerminalViewport(
      viewport.cols,
      viewport.rows
    )

    if (mode === 'desktop') {
      // Desktop-mode subscribe is passive; capture no baseline or floor until a deliberate gesture.
      inner.set(clientId, {
        clientId,
        viewport,
        wasResizedToPhone: false,
        previousCols: null,
        previousRows: null,
        subscribedAt,
        lastActedAt: now
      })
      return false
    }

    inner.set(clientId, {
      clientId,
      viewport,
      wasResizedToPhone: true,
      previousCols,
      previousRows,
      subscribedAt,
      lastActedAt: now
    })

    // Subscribe-fresh with auto/phone counts as "take the floor".
    this.setDriver(ptyId, { kind: 'mobile', clientId })

    // The first transition has no layout entry yet; admit it through the fresh-subscribe guard.
    this.freshSubscribeGuard.add(ptyId)
    try {
      await this.enqueueLayout(ptyId, {
        kind: 'phone',
        cols: clampedCols,
        rows: clampedRows,
        ownerClientId: clientId
      })
    } finally {
      this.freshSubscribeGuard.delete(ptyId)
    }

    return true
  }
}
