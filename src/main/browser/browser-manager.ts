import { clipboard, Menu, shell, webContents } from 'electron'

export type BrowserGuestRegistration = {
  browserTabId: string
  webContentsId: number
}

const LOCAL_ADDRESS_PATTERN =
  /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[[0-9a-f:]+\])(?::\d+)?(?:\/.*)?$/i

function normalizeExternalUrl(rawUrl: string): string | null {
  if (rawUrl === 'about:blank') {
    return rawUrl
  }

  if (LOCAL_ADDRESS_PATTERN.test(rawUrl)) {
    try {
      return new URL(`http://${rawUrl}`).toString()
    } catch {
      return null
    }
  }

  try {
    const parsed = new URL(rawUrl)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null
  } catch {
    return null
  }
}

class BrowserManager {
  private readonly webContentsIdByTabId = new Map<string, number>()
  private readonly contextMenuCleanupByTabId = new Map<string, () => void>()

  private openValidatedExternal(rawUrl: string): void {
    const externalUrl = normalizeExternalUrl(rawUrl)
    if (externalUrl && externalUrl !== 'about:blank') {
      void shell.openExternal(externalUrl)
    }
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

    this.webContentsIdByTabId.set(browserTabId, webContentsId)

    guest.setBackgroundThrottling(true)
    guest.setWindowOpenHandler(({ url }) => {
      // Why: browser tabs are still a scoped IDE surface, not a full popup
      // manager. Falling back to the system browser for guest-created windows
      // avoids orphan Electron windows until Orca has explicit new-tab/new-split
      // UX for popup flows.
      this.openValidatedExternal(url)
      return { action: 'deny' }
    })
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
        const externalLinkUrl = normalizeExternalUrl(linkUrl)
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

      const externalPageUrl = normalizeExternalUrl(pageUrl)

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
