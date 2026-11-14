import { webContents } from 'electron'
import { BrowserManagerDownloadLifecycle } from '../downloads/browser-manager-download-lifecycle'
import type { BrowserDevToolsDockBounds } from '../../../../../shared/browser/devtools/browser-devtools-dock'

export abstract class BrowserManagerDevTools extends BrowserManagerDownloadLifecycle {
  async openDevTools(
    browserTabId: string,
    inspectAt?: { x: number; y: number },
    options?: { detach?: boolean }
  ): Promise<boolean> {
    const guest = this.resolveDevToolsGuest(browserTabId)
    if (!guest) {
      return false
    }
    const renderer = this.resolveRendererForBrowserTab(browserTabId)
    const operation = this.devToolsDock.beginOpen(
      guest,
      () =>
        this.webContentsIdByTabId.get(browserTabId) === guest.id &&
        !this.offscreenGuestIds.has(guest.id) &&
        (!renderer ||
          (this.resolveRendererForBrowserTab(browserTabId) === renderer && !renderer.isDestroyed()))
    )
    const notify = (docked: boolean): void => {
      const currentGuestId = this.webContentsIdByTabId.get(browserTabId)
      if (
        renderer &&
        !renderer.isDestroyed() &&
        (currentGuestId === undefined ||
          currentGuestId === guest.id ||
          (!docked && !this.devToolsDock.isDocked(currentGuestId)))
      ) {
        renderer.send('browser:devToolsDockChanged', { browserPageId: browserTabId, docked })
      }
    }
    try {
      let docked = false
      if (!options?.detach && renderer) {
        docked = await this.devToolsDock.open(guest, () => notify(false), operation)
        if (!operation.isCurrent()) {
          return false
        }
      }
      if (!docked && !(await this.devToolsDock.openDetached(guest, operation))) {
        return false
      }
      if (!operation.isCurrent()) {
        return false
      }
      if (docked) {
        notify(true)
      }
      if (!operation.isCurrent()) {
        return false
      }
      if (inspectAt) {
        // Open first: inspectElement alone opens Electron's own DevTools and bypasses the dock.
        guest.inspectElement(inspectAt.x, inspectAt.y)
      }
      return true
    } finally {
      operation.finish()
    }
  }

  closeDevTools(browserTabId: string): void {
    const guest = this.resolveDevToolsGuest(browserTabId)
    if (guest) {
      this.closeGuestDevTools(guest)
    }
  }

  /** Toggles the page DevTools of `focused` (the page or its DevTools); false if it is neither. */
  toggleDevToolsOfFocusedPage(focused: Electron.WebContents): boolean {
    for (const [browserTabId, guestId] of this.webContentsIdByTabId) {
      const guest = webContents.fromId(guestId)
      if (!guest || guest.isDestroyed()) {
        continue
      }
      if (guest !== focused && guest.devToolsWebContents !== focused) {
        continue
      }
      if (
        this.devToolsDock.isOpening(guest.id) ||
        this.devToolsDock.isDocked(guest.id) ||
        guest.isDevToolsOpened()
      ) {
        this.closeGuestDevTools(guest)
      } else {
        void this.openDevTools(browserTabId)
      }
      return true
    }
    return false
  }

  setDevToolsDockBounds(
    browserTabId: string,
    bounds: BrowserDevToolsDockBounds | null,
    snapshot: boolean
  ): Promise<string | null> {
    const guestId = this.webContentsIdByTabId.get(browserTabId)
    return guestId === undefined
      ? Promise.resolve(null)
      : this.devToolsDock.setBounds(guestId, bounds, snapshot)
  }

  private resolveDevToolsGuest(browserTabId: string): Electron.WebContents | null {
    const webContentsId = this.webContentsIdByTabId.get(browserTabId)
    if (!webContentsId) {
      return null
    }
    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
      this.unregisterGuest(browserTabId)
      return null
    }
    // Offscreen DevTools would open on the server desktop without a route back to the client.
    return this.offscreenGuestIds.has(webContentsId) ? null : guest
  }
}
