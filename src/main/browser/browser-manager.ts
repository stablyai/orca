import { clipboard, Menu, shell, webContents } from 'electron'
import {
  normalizeBrowserNavigationUrl,
  normalizeExternalBrowserUrl
} from '../../shared/browser-url'

export type BrowserGuestRegistration = {
  browserTabId: string
  webContentsId: number
}

class BrowserManager {
  private readonly webContentsIdByTabId = new Map<string, number>()
  private readonly contextMenuCleanupByTabId = new Map<string, () => void>()
  private readonly policyAttachedGuestIds = new Set<number>()

  private openValidatedExternal(rawUrl: string): void {
    const externalUrl = normalizeExternalBrowserUrl(rawUrl)
    if (externalUrl) {
      void shell.openExternal(externalUrl)
    }
  }

  attachGuestPolicies(guest: Electron.WebContents): void {
    if (this.policyAttachedGuestIds.has(guest.id)) {
      return
    }
    this.policyAttachedGuestIds.add(guest.id)
    guest.setBackgroundThrottling(true)
    guest.setWindowOpenHandler(({ url }) => {
      // Why: popup-capable guests are required for OAuth and target=_blank
      // flows, but Orca still does not host child windows itself. Convert those
      // attempts into a controlled external-open path instead of letting them
      // silently fail or spawn unmanaged windows.
      this.openValidatedExternal(url)
      return { action: 'deny' }
    })

    const navigationGuard = (event: Electron.Event, url: string): void => {
      if (!normalizeBrowserNavigationUrl(url)) {
        // Why: `will-attach-webview` only validates the initial src. Main must
        // keep enforcing the same allowlist for later guest navigations too.
        event.preventDefault()
      }
    }

    guest.on('will-navigate', navigationGuard)
    guest.on('will-redirect', navigationGuard)
  }

  registerGuest({ browserTabId, webContentsId }: BrowserGuestRegistration): void {
    const previousCleanup = this.contextMenuCleanupByTabId.get(browserTabId)
    if (previousCleanup) {
      previousCleanup()
      this.contextMenuCleanupByTabId.delete(browserTabId)
    }

    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
      return
    }

    // Why: the renderer sends webContentsId, which we must not blindly trust.
    // A compromised renderer could send the main window's own webContentsId,
    // causing us to overwrite its setWindowOpenHandler or attach unintended
    // context menus. Only accept genuine webview guest surfaces.
    if (guest.getType() !== 'webview') {
      return
    }
    if (!this.policyAttachedGuestIds.has(webContentsId)) {
      // Why: renderer registration is only the second half of the guest setup.
      // Main must only trust guests that already passed attach-time policy
      // installation; otherwise a trusted renderer could point us at some other
      // arbitrary webview and bypass the intended host-window attach boundary.
      return
    }

    this.webContentsIdByTabId.set(browserTabId, webContentsId)

    this.setupContextMenu(browserTabId, guest)
  }

  unregisterGuest(browserTabId: string): void {
    const cleanup = this.contextMenuCleanupByTabId.get(browserTabId)
    if (cleanup) {
      cleanup()
      this.contextMenuCleanupByTabId.delete(browserTabId)
    }
    this.webContentsIdByTabId.delete(browserTabId)
  }

  unregisterAll(): void {
    for (const browserTabId of this.webContentsIdByTabId.keys()) {
      this.unregisterGuest(browserTabId)
    }
    this.policyAttachedGuestIds.clear()
  }

  getGuestWebContentsId(browserTabId: string): number | null {
    return this.webContentsIdByTabId.get(browserTabId) ?? null
  }

  // Why: guest browser surfaces are intentionally isolated from Orca's preload
  // bridge, so renderer code cannot directly call Electron WebContents APIs on
  // them. Main owns the devtools escape hatch and only after tab→guest lookup.
  async openDevTools(browserTabId: string): Promise<boolean> {
    const webContentsId = this.webContentsIdByTabId.get(browserTabId)
    if (!webContentsId) {
      return false
    }
    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
      this.webContentsIdByTabId.delete(browserTabId)
      return false
    }
    guest.openDevTools({ mode: 'detach' })
    return true
  }

  private setupContextMenu(browserTabId: string, guest: Electron.WebContents): void {
    const handler = (_event: Electron.Event, params: Electron.ContextMenuParams): void => {
      const pageUrl = guest.getURL()
      const linkUrl = params.linkURL || ''

      const template: Electron.MenuItemConstructorOptions[] = []

      if (linkUrl) {
        const externalLinkUrl = normalizeExternalBrowserUrl(linkUrl)
        template.push(
          {
            label: 'Open Link In Default Browser',
            enabled: Boolean(externalLinkUrl && externalLinkUrl !== 'about:blank'),
            click: () => {
              this.openValidatedExternal(linkUrl)
            }
          },
          {
            label: 'Copy Link Address',
            click: () => {
              clipboard.writeText(linkUrl)
            }
          },
          { type: 'separator' }
        )
      }

      const externalPageUrl = normalizeExternalBrowserUrl(pageUrl)

      template.push(
        {
          label: 'Back',
          enabled: guest.canGoBack(),
          click: () => guest.goBack()
        },
        {
          label: 'Forward',
          enabled: guest.canGoForward(),
          click: () => guest.goForward()
        },
        {
          label: 'Reload',
          click: () => guest.reload()
        },
        { type: 'separator' },
        {
          label: 'Open Page In Default Browser',
          enabled: Boolean(externalPageUrl && externalPageUrl !== 'about:blank'),
          click: () => {
            this.openValidatedExternal(pageUrl)
          }
        },
        {
          label: 'Copy Page URL',
          enabled: Boolean(pageUrl),
          click: () => {
            clipboard.writeText(pageUrl)
          }
        },
        { type: 'separator' },
        {
          label: 'Inspect Page',
          click: () => {
            void this.openDevTools(browserTabId)
          }
        }
      )

      Menu.buildFromTemplate(template).popup()
    }

    guest.on('context-menu', handler)
    this.contextMenuCleanupByTabId.set(browserTabId, () => {
      try {
        guest.off('context-menu', handler)
      } catch {
        // Why: browser tabs can outlive the guest webContents briefly during
        // teardown. Cleanup should be best-effort instead of throwing while the
        // IDE is closing a tab.
      }
    })
  }
}

export const browserManager = new BrowserManager()
