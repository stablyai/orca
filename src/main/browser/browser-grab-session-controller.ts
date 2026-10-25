import type { BrowserGrabCancelReason, BrowserGrabResult } from '../../shared/browser-grab-types'
import { buildGuestOverlayScript } from './grab-guest-script'
import { clampGrabPayload } from './browser-grab-payload'

type ActiveGrabOp = {
  opId: string
  browserTabId: string
  guestWebContentsId: number
  resolve: (result: BrowserGrabResult) => void
  /** Preserve the overlay while the selection copy menu is open. */
  cleanup: (preserveOverlay?: boolean) => void
  /** Replacing an operation must not tear down its newly armed overlay. */
  skipTeardown?: boolean
}

const GRAB_OP_TIMEOUT_MS = 120_000

function isGuestCancellationPayload(rawPayload: unknown): boolean {
  if (!rawPayload || typeof rawPayload !== 'object') {
    return false
  }
  const payload = rawPayload as Record<string, unknown>
  if (payload.__orcaCancelled === true) {
    return true
  }
  // Accept legacy cancellation errors without misclassifying page-authored payload fields.
  if (payload.message !== 'cancelled') {
    return false
  }
  return !('page' in payload) && !('target' in payload) && !('payload' in payload)
}

function getGuestErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message
  }
  if (err && typeof err === 'object') {
    const message = (err as Record<string, unknown>).message
    if (typeof message === 'string') {
      return message
    }
  }
  return 'Selection failed'
}

export class BrowserGrabSessionController {
  private readonly activeGrabOps = new Map<string, ActiveGrabOp>()

  hasActiveGrabOp(browserTabId: string): boolean {
    return this.activeGrabOps.has(browserTabId)
  }

  cancelGrabOp(browserTabId: string, reason: BrowserGrabCancelReason): void {
    const op = this.activeGrabOps.get(browserTabId)
    if (!op) {
      return
    }
    // resolve already cleans up; repeating cleanup would inject teardown twice.
    op.resolve({ opId: op.opId, kind: 'cancelled', reason })
  }

  cancelAll(reason: BrowserGrabCancelReason): void {
    for (const browserTabId of this.activeGrabOps.keys()) {
      this.cancelGrabOp(browserTabId, reason)
    }
  }

  /** Guest overlays consume mouse clicks; page capture-phase listeners may still observe them. */
  awaitGrabSelection(
    browserTabId: string,
    opId: string,
    guest: Electron.WebContents
  ): Promise<BrowserGrabResult> {
    const existing = this.activeGrabOps.get(browserTabId)
    if (existing) {
      // Preserve the shared overlay: teardown would race the replacement awaitClick script.
      existing.skipTeardown = true
      existing.resolve({ opId: existing.opId, kind: 'cancelled', reason: 'user' })
    }

    return new Promise<BrowserGrabResult>((resolve) => {
      const guestWebContentsId = guest.id
      let settled = false

      const settleOnce = (result: BrowserGrabResult): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeoutId)
        // Keep the selection highlight until the renderer dismisses or rearms the picker.
        op.cleanup(result.kind === 'selected' || result.kind === 'context-selected')
        this.activeGrabOps.delete(browserTabId)
        resolve(result)
      }

      const awaitGuestClick = async (): Promise<void> => {
        try {
          const rawPayload = await guest.executeJavaScript(buildGuestOverlayScript('awaitClick'))
          if (!rawPayload || typeof rawPayload !== 'object') {
            settleOnce({ opId, kind: 'cancelled', reason: 'user' })
            return
          }
          // Classify normal cancellation before validating selection payloads.
          if (isGuestCancellationPayload(rawPayload)) {
            settleOnce({ opId, kind: 'cancelled', reason: 'user' })
            return
          }
          // Right-click selections open the action menu instead of auto-copying.
          const isContextMenu =
            '__orcaContextMenu' in (rawPayload as Record<string, unknown>) &&
            (rawPayload as Record<string, unknown>).__orcaContextMenu === true
          const payloadSource = isContextMenu
            ? (rawPayload as Record<string, unknown>).payload
            : rawPayload
          const payload = clampGrabPayload(payloadSource)
          if (!payload) {
            settleOnce({ opId, kind: 'error', reason: 'Guest returned invalid payload structure' })
            return
          }
          settleOnce({
            opId,
            kind: isContextMenu ? 'context-selected' : 'selected',
            payload
          })
        } catch (err) {
          const message = getGuestErrorMessage(err)
          if (message.includes('cancelled')) {
            settleOnce({ opId, kind: 'cancelled', reason: 'user' })
          } else {
            settleOnce({ opId, kind: 'error', reason: message })
          }
        }
      }

      // Subframe navigations, such as ad loads, must not cancel the selection.
      const handleNavigation = (
        _event: unknown,
        _url: unknown,
        _isInPlace: unknown,
        isMainFrame: boolean
      ): void => {
        if (isMainFrame) {
          settleOnce({ opId, kind: 'cancelled', reason: 'navigation' })
        }
      }

      const handleDestroyed = (): void => {
        settleOnce({ opId, kind: 'cancelled', reason: 'evicted' })
      }

      const timeoutId = setTimeout(() => {
        settleOnce({ opId, kind: 'cancelled', reason: 'timeout' })
      }, GRAB_OP_TIMEOUT_MS)
      // An armed grab must not keep Electron main alive after its window closes.
      if (typeof timeoutId.unref === 'function') {
        timeoutId.unref()
      }

      guest.on('did-start-navigation', handleNavigation)
      guest.on('destroyed', handleDestroyed)

      const cleanup = (preserveOverlay?: boolean): void => {
        try {
          guest.off('did-start-navigation', handleNavigation)
          guest.off('destroyed', handleDestroyed)
        } catch {
          // The guest may already be destroyed.
        }
        if (op.skipTeardown || preserveOverlay) {
          return
        }
        try {
          if (!guest.isDestroyed()) {
            void guest.executeJavaScript(buildGuestOverlayScript('teardown'))
          }
        } catch {
          // Best-effort overlay removal
        }
      }

      const op: ActiveGrabOp = {
        opId,
        browserTabId,
        guestWebContentsId,
        resolve: settleOnce,
        cleanup
      }
      this.activeGrabOps.set(browserTabId, op)
      void awaitGuestClick()
    })
  }
}
