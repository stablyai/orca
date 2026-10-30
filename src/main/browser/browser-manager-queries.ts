import { webContents } from 'electron'
import type {
  BrowserCertificateFailure,
  BrowserLoadError
} from '../../shared/browser-workspace-types'
import type { ManagedBrowserGuestContext } from './browser-certificate-trust-controller'
import { redactKagiSessionToken } from '../../shared/browser-url'
import { safeOrigin, type BrowserPopupPage } from './browser-manager-types'
import { BrowserManagerRegistration } from './browser-manager-registration'
import {
  isBrowserRouteGuestPopup,
  listBrowserRouteGuestPopups
} from './browser-route-guest-popup-ownership'
import { browserPopupPageId, browserPopupPageWebContentsId } from './browser-popup-page-id'

export abstract class BrowserManagerQueries extends BrowserManagerRegistration {
  getGuestWebContentsId(browserTabId: string): number | null {
    return this.webContentsIdByTabId.get(browserTabId) ?? null
  }

  getWebContentsIdByTabId(): Map<string, number> {
    return this.webContentsIdByTabId
  }

  getTabIdForWebContentsId(webContentsId: number): string | null {
    return this.tabIdByWebContentsId.get(webContentsId) ?? null
  }

  /** Includes popups owned by the page. */
  getOwningTabIdForGuestWebContentsId(guestWebContentsId: number): string | null {
    return this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
  }

  /** A popup page belongs to its opener tab, sharing its workspace and profile. */
  getOwningTabIdForPage(browserPageId: string): string {
    const popupWebContentsId = this.resolvePopupPageWebContentsId(browserPageId)
    const ownerTabId =
      popupWebContentsId === null
        ? null
        : this.resolvePopupOwnerContext(popupWebContentsId)?.browserTabId
    return ownerTabId ?? browserPageId
  }

  // A tab created with a popup-shaped id keeps it; the popup goes unlisted rather than shadow it.
  private resolvePopupPageWebContentsId(browserPageId: string): number | null {
    const webContentsId = browserPopupPageWebContentsId(browserPageId)
    return webContentsId !== null &&
      !this.webContentsIdByTabId.has(browserPageId) &&
      (this.popupOwnerContextByGuestId.has(webContentsId) ||
        isBrowserRouteGuestPopup(webContentsId))
      ? webContentsId
      : null
  }

  getWorktreeIdForTab(browserTabId: string): string | undefined {
    return this.worktreeIdByTabId.get(this.getOwningTabIdForPage(browserTabId))
  }

  getSessionProfileIdForTab(browserTabId: string): string | null {
    return this.sessionProfileIdByPageId.get(this.getOwningTabIdForPage(browserTabId)) ?? null
  }

  /** Native popups (OAuth, payment) keep their opener, so agents reach them as pages beside their tab. */
  getPopupPages(): BrowserPopupPage[] {
    const popupWebContentsIds = new Set([
      ...this.popupOwnerContextByGuestId.keys(),
      ...listBrowserRouteGuestPopups()
    ])
    const pages: BrowserPopupPage[] = []
    for (const webContentsId of popupWebContentsIds) {
      const browserPageId = browserPopupPageId(webContentsId)
      const openerBrowserPageId = this.resolvePopupOwnerContext(webContentsId)?.browserTabId
      const popup = webContents.fromId(webContentsId)
      if (
        openerBrowserPageId &&
        !this.webContentsIdByTabId.has(browserPageId) &&
        popup &&
        !popup.isDestroyed()
      ) {
        pages.push({
          browserPageId,
          webContentsId,
          openerBrowserPageId
        })
      }
    }
    return pages
  }

  /** Closes a popup page as the page's own window.close() would; false when it is not a live popup. */
  async closePopupPage(browserPageId: string): Promise<boolean> {
    const page = this.getPopupPages().find((popup) => popup.browserPageId === browserPageId)
    const popup = page ? webContents.fromId(page.webContentsId) : undefined
    if (!popup || popup.isDestroyed()) {
      return false
    }
    // Settle after the agent is handed back to the opener, so its next command lands there.
    await new Promise<void>((resolve) => {
      popup.once('destroyed', () => resolve())
      popup.close()
    })
    return true
  }

  getBrowserPageLoadError(browserPageId: string): BrowserLoadError | null {
    const webContentsId =
      this.webContentsIdByTabId.get(browserPageId) ??
      this.resolvePopupPageWebContentsId(browserPageId) ??
      undefined
    return webContentsId === undefined
      ? null
      : (this.loadErrorsByGuestId.get(webContentsId) ?? null)
  }

  getBrowserPageCertificateFailure(browserPageId: string): BrowserCertificateFailure | null {
    return this.certificateTrustController?.getFailure(browserPageId) ?? null
  }

  getManagedBrowserGuestContext(webContentsId: number): ManagedBrowserGuestContext | null {
    if (this.popupOwnerContextByGuestId.has(webContentsId)) {
      return null
    }
    const browserPageId = this.tabIdByWebContentsId.get(webContentsId) ?? null
    const offscreen = this.offscreenGuestIds.has(webContentsId)
    if (!offscreen && !this.policyAttachedGuestIds.has(webContentsId)) {
      return null
    }
    if (!offscreen) {
      const guest = webContents.fromId(webContentsId)
      if (!guest || guest.isDestroyed() || guest.getType() !== 'webview') {
        return null
      }
    }
    return {
      browserPageId,
      worktreeId: browserPageId ? (this.worktreeIdByTabId.get(browserPageId) ?? null) : null,
      sessionProfileId: browserPageId
        ? (this.sessionProfileIdByPageId.get(browserPageId) ?? null)
        : null,
      owner: offscreen ? 'offscreen' : 'desktop-webview'
    }
  }

  // Redact Kagi tokens on every load-error path, including certificate failures.
  protected buildLoadError(code: number, description: string, rawUrl: string): BrowserLoadError {
    return {
      code,
      description,
      validatedUrl: redactKagiSessionToken(rawUrl)
    }
  }

  notifyCertificateFailureChanged(
    webContentsId: number,
    failure: BrowserCertificateFailure | null,
    navigationUrl?: string
  ): void {
    if (failure && navigationUrl) {
      const loadError = this.buildLoadError(failure.errorCode ?? -1, failure.error, navigationUrl)
      this.loadErrorsByGuestId.set(webContentsId, loadError)
      this.forwardOrQueueGuestLoadFailure(webContentsId, loadError)
    }
    const browserPageId = this.tabIdByWebContentsId.get(webContentsId)
    if (!browserPageId) {
      return
    }
    if (this.offscreenGuestIds.has(webContentsId)) {
      this.notifyBrowserGuestStateChanged(webContentsId)
      return
    }
    const renderer = this.resolveRendererForBrowserTab(browserPageId)
    renderer?.send('browser:certificate-failure-changed', { browserPageId, failure })
  }

  protected notifyBrowserGuestStateChanged(webContentsId: number): void {
    if (!this.offscreenGuestIds.has(webContentsId)) {
      return
    }
    const browserPageId = this.tabIdByWebContentsId.get(webContentsId)
    const worktreeId = browserPageId ? this.worktreeIdByTabId.get(browserPageId) : null
    if (worktreeId) {
      // Isolate listener exceptions from Electron event dispatch.
      try {
        this.browserGuestStateChangedListener?.(worktreeId)
      } catch (error) {
        console.error('[browser-manager] browserGuestStateChanged listener failed', error)
      }
    }
  }

  notifyPermissionDenied(args: {
    guestWebContentsId: number
    permission: string
    rawUrl: string
  }): void {
    this.forwardOrQueuePermissionDenied(args.guestWebContentsId, {
      permission: args.permission,
      origin: safeOrigin(args.rawUrl)
    })
  }
}
