import type {
  BrowserGrabCancelReason,
  BrowserGrabResult
} from '../../../shared/browser/element-grab/browser-grab-types'
import { retainPickedElement } from './grab-picked-element'
import {
  executeGrabScript,
  requestGrabExecution,
  grabDocumentScope,
  retireGrabOverlay
} from './grab-guest-execution'
import { clampGrabPayload } from './browser-grab-payload'
import { readDocPreviewGuestDocumentUrl } from '../document-preview/doc-preview-guest-policy'

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
  return false
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
  private readonly replacing = new Set<string>()

  constructor(private readonly onSettled?: (pageId: string, guest: Electron.WebContents) => void) {}

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
    if (this.replacing.has(browserTabId)) {
      return Promise.resolve({ opId, kind: 'cancelled', reason: 'user' })
    }
    const existing = this.activeGrabOps.get(browserTabId)
    if (existing) {
      // Preserve the shared overlay: teardown would race the replacement awaitClick script.
      existing.skipTeardown = true
      existing.resolve({ opId: existing.opId, kind: 'cancelled', reason: 'user' })
    }

    return new Promise<BrowserGrabResult>((resolve) => {
      const scope = grabDocumentScope(guest)
      const abort = new AbortController()
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
        this.onSettled?.(browserTabId, guest)
        resolve(result)
      }

      const awaitGuestClick = async (): Promise<void> => {
        try {
          if (existing) {
            this.replacing.add(browserTabId)
            try {
              const cancelled = await executeGrabScript(guest, '', {
                signal: abort.signal,
                scope,
                overlayAction: { action: 'cancelAwait', argument: false }
              })
              if (cancelled !== true || settled) {
                settleOnce({ opId, kind: 'cancelled', reason: 'user' })
                return
              }
            } finally {
              this.replacing.delete(browserTabId)
            }
          }
          const execution = await requestGrabExecution(guest, '', {
            selection: true,
            signal: abort.signal,
            scope,
            capturePick: 'held',
            overlayAction: { action: 'awaitClick' }
          })
          if (settled) {
            return
          }
          if (!execution.ok) {
            settleOnce({ opId, kind: 'error', reason: 'Guest selection unavailable' })
            return
          }
          const rawPayload = execution.value
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
          const payload = clampGrabPayload(payloadSource, readDocPreviewGuestDocumentUrl(guest))
          if (!payload) {
            settleOnce({ opId, kind: 'error', reason: 'Guest returned invalid payload structure' })
            return
          }
          if (settled) {
            return
          }
          const retained = await retainPickedElement(
            guest,
            payload.page.selectionId ?? payload.page.capturedAt,
            scope
          )
          if (retained !== true) {
            settleOnce(
              retained === false
                ? { opId, kind: 'cancelled', reason: 'user' }
                : { opId, kind: 'error', reason: 'Guest selection unavailable' }
            )
            return
          }
          settleOnce({
            opId,
            kind: isContextMenu ? 'context-selected' : 'selected',
            payload
          })
        } catch (err) {
          settleOnce({ opId, kind: 'error', reason: getGuestErrorMessage(err) })
        }
      }

      // Subframe loads and in-place URL updates (scroll spies) keep the overlay's document.
      const handleNavigation = (
        _event: unknown,
        _url: unknown,
        isInPlace: boolean,
        isMainFrame: boolean
      ): void => {
        if (isMainFrame && !isInPlace) {
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
        abort.abort()
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
            retireGrabOverlay(scope)
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
