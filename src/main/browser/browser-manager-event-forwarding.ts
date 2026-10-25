import type {
  BrowserPermissionDeniedEvent,
  BrowserPopupEvent
} from '../../shared/browser-guest-events'
import { redactKagiSessionToken } from '../../shared/browser-url'
import { BrowserManagerBindings } from './browser-manager-bindings'
import type { PendingPermissionEvent, PendingPopupEvent } from './browser-manager-types'

export abstract class BrowserManagerEventForwarding extends BrowserManagerBindings {
  protected forwardOrQueueGuestLoadFailure(
    guestWebContentsId: number,
    loadError: { code: number; description: string; validatedUrl: string }
  ): void {
    const browserTabId = this.tabIdByWebContentsId.get(guestWebContentsId)
    if (!browserTabId) {
      // Failures can precede registration; registerGuest replays them by guest ID.
      this.pendingLoadFailuresByGuestId.set(guestWebContentsId, loadError)
      return
    }
    this.sendGuestLoadFailure(browserTabId, loadError, guestWebContentsId)
  }

  protected forwardOrQueuePermissionDenied(
    guestWebContentsId: number,
    event: PendingPermissionEvent
  ): void {
    const browserTabId = this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
    if (!browserTabId) {
      const pending = this.pendingPermissionEventsByGuestId.get(guestWebContentsId) ?? []
      pending.push(event)
      if (pending.length > 5) {
        pending.shift()
      }
      this.pendingPermissionEventsByGuestId.set(guestWebContentsId, pending)
      return
    }
    this.sendPermissionDenied(browserTabId, event, guestWebContentsId)
  }

  protected flushPendingPermissionEvents(browserTabId: string, guestWebContentsId: number): void {
    const pending = this.pendingPermissionEventsByGuestId.get(guestWebContentsId)
    if (!pending?.length) {
      return
    }
    this.pendingPermissionEventsByGuestId.delete(guestWebContentsId)
    for (const event of pending) {
      this.sendPermissionDenied(browserTabId, event, guestWebContentsId)
    }
  }

  protected sendPermissionDenied(
    browserTabId: string,
    event: PendingPermissionEvent,
    guestWebContentsId?: number
  ): void {
    const renderer =
      guestWebContentsId === undefined
        ? this.resolveRendererForBrowserTab(browserTabId)
        : this.getRendererContextForGuest(guestWebContentsId)?.renderer
    if (!renderer) {
      return
    }
    renderer.send('browser:permission-denied', {
      browserPageId: browserTabId,
      ...event
    } satisfies BrowserPermissionDeniedEvent)
  }

  protected forwardOrQueuePopupEvent(guestWebContentsId: number, event: PendingPopupEvent): void {
    const browserTabId = this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
    if (!browserTabId) {
      const pending = this.pendingPopupEventsByGuestId.get(guestWebContentsId) ?? []
      pending.push(event)
      if (pending.length > 5) {
        pending.shift()
      }
      this.pendingPopupEventsByGuestId.set(guestWebContentsId, pending)
      return
    }
    this.sendPopupEvent(browserTabId, event, guestWebContentsId)
  }

  protected flushPendingPopupEvents(browserTabId: string, guestWebContentsId: number): void {
    const pending = this.pendingPopupEventsByGuestId.get(guestWebContentsId)
    if (!pending?.length) {
      return
    }
    this.pendingPopupEventsByGuestId.delete(guestWebContentsId)
    for (const event of pending) {
      this.sendPopupEvent(browserTabId, event, guestWebContentsId)
    }
  }

  protected sendPopupEvent(
    browserTabId: string,
    event: PendingPopupEvent,
    guestWebContentsId?: number
  ): void {
    const renderer =
      guestWebContentsId === undefined
        ? this.resolveRendererForBrowserTab(browserTabId)
        : this.getRendererContextForGuest(guestWebContentsId)?.renderer
    if (!renderer) {
      return
    }
    renderer.send('browser:popup', {
      browserPageId: browserTabId,
      ...event
    } satisfies BrowserPopupEvent)
  }

  protected flushPendingLoadFailure(browserTabId: string, guestWebContentsId: number): void {
    const pending = this.pendingLoadFailuresByGuestId.get(guestWebContentsId)
    if (!pending) {
      return
    }
    this.pendingLoadFailuresByGuestId.delete(guestWebContentsId)
    this.sendGuestLoadFailure(browserTabId, pending, guestWebContentsId)
  }

  protected sendGuestLoadFailure(
    browserTabId: string,
    loadError: { code: number; description: string; validatedUrl: string },
    guestWebContentsId?: number
  ): void {
    const renderer =
      guestWebContentsId === undefined
        ? this.resolveRendererForBrowserTab(browserTabId)
        : this.getRendererContextForGuest(guestWebContentsId)?.renderer
    if (!renderer) {
      return
    }
    renderer.send('browser:guest-load-failed', {
      browserPageId: browserTabId,
      loadError: {
        ...loadError,
        validatedUrl: redactKagiSessionToken(loadError.validatedUrl)
      }
    })
  }
}
