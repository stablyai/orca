import type { BrowserWindow } from 'electron'
import type { OffscreenBrowserPage } from './offscreen-browser-open-pages'
import { createOffscreenBrowserWindow } from './offscreen-browser-window'

// Why (STA-4341): building a page's renderer and wiring it to the page record
// is one transaction — the window, the address tracking that keeps the record
// wakeable, the loss handler that cleans up a crash, and the guest
// registration. The backend owns what happens on those events; this module
// owns that they are attached to every renderer identically, whether it came
// from a create or a wake.

export type OffscreenBrowserRendererHooks = {
  /** A teardown the owner started on purpose — the loss handler stands down. */
  isDeliberateTeardown: (browserPageId: string) => boolean
  /** The renderer died out from under the owner (crash, app teardown). */
  onRendererLost: (webContentsId: number) => void
  /** Map the fresh WebContents into the guest registries. */
  registerGuest: (webContentsId: number) => void
}

export function materializeOffscreenBrowserRenderer(
  page: OffscreenBrowserPage,
  hooks: OffscreenBrowserRendererHooks
): void {
  const win = createOffscreenBrowserWindow(page.partition)
  try {
    attachWindow(page, win, hooks)
  } catch (error) {
    // Why: the window exists before anything that can fail. Abandoning it
    // here would leak a hidden renderer nothing owns or can reach.
    page.window = null
    if (!win.isDestroyed()) {
      win.destroy()
    }
    throw error
  }
}

function attachWindow(
  page: OffscreenBrowserPage,
  win: BrowserWindow,
  hooks: OffscreenBrowserRendererHooks
): void {
  page.window = win
  // Why: reading win.webContents once the contents are destroyed throws, and
  // the throw would escape the 'destroyed' listener into the main process.
  // Capture the id while it is still safe to read.
  const webContentsId = win.webContents.id
  // Why: the record's address must follow the page, not the create call — an
  // agent that navigates with `goto` or in-page script has to be woken back
  // to where it actually is. A chrome-error address is the failure, not a
  // destination, so it never replaces the address that produced it.
  const recordAddress = (url: string): void => {
    if (page.window === win && url && !url.startsWith('chrome-error://')) {
      page.url = url
    }
  }
  // did-navigate is main-frame only; did-frame-navigate covers subframes.
  win.webContents.on('did-navigate', (_event, url) => recordAddress(url))
  // Why: an iframe changing its own hash also fires did-navigate-in-page. A
  // subframe navigation is not a navigation of the tab, and adopting its
  // address would wake the page onto the iframe's document.
  win.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame) {
      recordAddress(url)
    }
  })
  // Why: if the window is destroyed out from under us (crash, app teardown),
  // report the loss so commands fail cleanly instead of resolving a dead
  // WebContents. Parking destroys it deliberately, so it opts out here.
  win.webContents.once('destroyed', () => {
    if (hooks.isDeliberateTeardown(page.browserPageId) || page.window !== win) {
      return
    }
    hooks.onRendererLost(webContentsId)
  })
  hooks.registerGuest(webContentsId)
}
