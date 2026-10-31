import { BrowserWindow, WebContentsView } from 'electron'
import type { BrowserDevToolsDockBounds } from '../../shared/browser-devtools-dock'

type DevToolsOpenOperation = {
  isCurrent: () => boolean
  finish: () => void
}

type DockedDevTools = {
  operation: DevToolsOpenOperation
  guest: Electron.WebContents
  /** Replaced after a page crash; the entry itself lives until DevTools close. */
  view: WebContentsView
  window: BrowserWindow
  /** Drops the guest listeners and reports the close. */
  dispose: () => void
  /** Bumped by every bounds update, so a slow snapshot can't hide a view shown after it. */
  boundsGeneration: number
}

/** DevTools for a page guest, shown in a native view the renderer positions inside the pane.
 *  A <webview> can't host the frontend on Electron 43 (it never connects), so the host is a
 *  WebContentsView laid over the pane's DevTools slot; the renderer owns the slot's layout. */
export class BrowserGuestDevToolsDock {
  private readonly docks = new Map<number, DockedDevTools>()
  /** Hosts still detaching: Electron opens nothing for a guest until its old frontend lets go. */
  private readonly releases = new Map<number, Promise<void>>()
  private readonly pendingOpens = new Map<number, DevToolsOpenOperation>()

  isDocked(guestId: number): boolean {
    return this.docks.has(guestId)
  }

  isOpening(guestId: number): boolean {
    return this.pendingOpens.has(guestId)
  }

  beginOpen(
    guest: Electron.WebContents,
    isCurrent: () => boolean = () => true
  ): DevToolsOpenOperation {
    const operation: DevToolsOpenOperation = {
      isCurrent: () =>
        this.pendingOpens.get(guest.id) === operation && !guest.isDestroyed() && isCurrent(),
      finish: () => {
        try {
          if (!operation.isCurrent() && this.docks.get(guest.id)?.operation === operation) {
            void this.releaseDock(guest.id)
          }
        } finally {
          if (this.pendingOpens.get(guest.id) === operation) {
            this.pendingOpens.delete(guest.id)
          }
        }
      }
    }
    this.pendingOpens.set(guest.id, operation)
    const dock = this.docks.get(guest.id)
    if (dock) {
      dock.operation = operation
    }
    return operation
  }

  /** Returns false when docking is unavailable or superseded. */
  open(
    guest: Electron.WebContents,
    onClosed: () => void,
    operation?: DevToolsOpenOperation
  ): Promise<boolean> {
    const pending = operation ?? this.beginOpen(guest)
    const opened = this.openDock(guest, onClosed, pending)
    return operation ? opened : opened.finally(pending.finish)
  }

  private async openDock(
    guest: Electron.WebContents,
    onClosed: () => void,
    operation: DevToolsOpenOperation
  ): Promise<boolean> {
    await this.releases.get(guest.id)
    if (!operation.isCurrent()) {
      return false
    }
    const existing = this.docks.get(guest.id)
    if (existing) {
      existing.operation = operation
      existing.view.webContents?.focus()
      return true
    }
    const host = guest.hostWebContents
    const window = host ? BrowserWindow.fromWebContents(host) : null
    if (!window || window.isDestroyed()) {
      return false
    }
    if (guest.isDevToolsOpened()) {
      // Electron ignores a custom host while its own DevTools window exists.
      guest.closeDevTools()
    }
    let phase: 'live' | 'crashed' | 'reconnecting' = 'live'
    const handleCrash = (): void => {
      phase = 'crashed'
    }
    // A crash leaves the frontend detached for good. Once the page is back, drop the stale host;
    // its devtools-closed then brings up a fresh one in the same place, like Chrome reconnecting.
    const handleDomReady = (): void => {
      const dock = this.docks.get(guest.id)
      if (phase === 'crashed' && dock) {
        phase = 'reconnecting'
        destroyView(window, dock.view)
      }
    }
    // Fires for DevTools' own close button and for the host being destroyed.
    const handleClosed = (): void => {
      const dock = this.docks.get(guest.id)
      if (dock && phase === 'reconnecting') {
        phase = 'live'
        // The stale view kept taking bounds while it detached, so it holds the latest ones.
        const stale = dock.view
        dock.view = attachDevToolsView(guest, window)
        dock.view.setBounds(stale.getBounds())
        dock.view.setVisible(stale.getVisible())
        return
      }
      void this.close(guest.id)
    }
    guest.on('render-process-gone', handleCrash)
    guest.on('dom-ready', handleDomReady)
    guest.on('devtools-closed', handleClosed)
    this.docks.set(guest.id, {
      operation,
      guest,
      view: attachDevToolsView(guest, window),
      window,
      dispose: () => {
        try {
          guest.off('render-process-gone', handleCrash)
          guest.off('dom-ready', handleDomReady)
          guest.off('devtools-closed', handleClosed)
        } catch {
          // guest may already be destroyed
        }
        onClosed()
      },
      boundsGeneration: 0
    })
    return true
  }

  async openDetached(
    guest: Electron.WebContents,
    operation: DevToolsOpenOperation
  ): Promise<boolean> {
    if (!operation.isCurrent()) {
      return false
    }
    await this.releaseDock(guest.id)
    if (!operation.isCurrent()) {
      return false
    }
    guest.openDevTools({ mode: 'detach' })
    return true
  }

  /** Bounds are in the host renderer's CSS pixels; null hides the view. With `snapshot`, the
   *  hidden view's last frame comes back so the renderer can paint it under an overlay. */
  async setBounds(
    guestId: number,
    bounds: BrowserDevToolsDockBounds | null,
    snapshot: boolean
  ): Promise<string | null> {
    const dock = this.docks.get(guestId)
    if (!dock || dock.window.isDestroyed()) {
      return null
    }
    const generation = ++dock.boundsGeneration
    if (bounds) {
      const zoom = dock.window.webContents.getZoomFactor()
      dock.view.setBounds({
        x: Math.round(bounds.x * zoom),
        y: Math.round(bounds.y * zoom),
        width: Math.round(bounds.width * zoom),
        height: Math.round(bounds.height * zoom)
      })
      dock.view.setVisible(true)
      return null
    }
    const host = dock.view.webContents
    // A host destroyed mid-capture rejects; hide anyway, without a snapshot.
    const image =
      snapshot && host && dock.view.getVisible() ? await host.capturePage().catch(() => null) : null
    if (dock.boundsGeneration === generation) {
      dock.view.setVisible(false)
    }
    // JPEG: it only shows under a backdrop or a drag, and encodes far faster than PNG.
    return image && !image.isEmpty()
      ? `data:image/jpeg;base64,${image.toJPEG(85).toString('base64')}`
      : null
  }

  /** Resolves once Electron has let go of the host, so DevTools can open again. */
  close(guestId: number): Promise<void> {
    this.pendingOpens.delete(guestId)
    return this.releaseDock(guestId)
  }

  private releaseDock(guestId: number): Promise<void> {
    const dock = this.docks.get(guestId)
    if (!dock) {
      return this.releases.get(guestId) ?? Promise.resolve()
    }
    this.docks.delete(guestId)
    dock.dispose()
    const released = waitForRelease(dock.guest, dock.view)
    this.releases.set(guestId, released)
    void released.then(() => {
      if (this.releases.get(guestId) === released) {
        this.releases.delete(guestId)
      }
    })
    destroyView(dock.window, dock.view)
    return released
  }
}

// Electron detaches the frontend when its host is destroyed and reports it as devtools-closed.
function waitForRelease(guest: Electron.WebContents, view: WebContentsView): Promise<void> {
  const host = view.webContents
  if (!host || host.isDestroyed() || guest.isDestroyed()) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const done = (): void => {
      try {
        guest.off('devtools-closed', done)
        guest.off('destroyed', done)
      } catch {
        // guest may already be destroyed
      }
      // Let the rest of the host's destruction run before anyone reopens.
      setImmediate(resolve)
    }
    guest.once('devtools-closed', done)
    guest.once('destroyed', done)
    // A frontend that closed itself already reported devtools-closed; its host may not again.
    host.once('destroyed', done)
  })
}

// Each open needs a fresh host: Electron loads the frontend only into one that never navigated.
function attachDevToolsView(guest: Electron.WebContents, window: BrowserWindow): WebContentsView {
  const view = new WebContentsView()
  // Hidden until the renderer reports where the slot is.
  view.setVisible(false)
  window.contentView.addChildView(view)
  guest.setDevToolsWebContents(view.webContents)
  guest.openDevTools()
  return view
}

function destroyView(window: BrowserWindow, view: WebContentsView): void {
  if (!window.isDestroyed()) {
    window.contentView.removeChildView(view)
  }
  // closeDevTools() leaves a custom host attached and frozen; destroying the host detaches it.
  // Electron drops webContents from a view whose contents are already gone.
  const host = view.webContents
  if (host && !host.isDestroyed()) {
    host.close()
  }
}
