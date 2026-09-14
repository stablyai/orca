import { screen } from 'electron'
import {
  normalizeBrowserNavigationUrl,
  normalizeExternalBrowserUrl,
  redactKagiSessionToken
} from '../../shared/browser-url'
import { readGuestNavigationState } from './browser-guest-navigation-state'
import type { ResolveRenderer } from './browser-guest-renderer-target'

export function setupGuestContextMenu(args: {
  browserTabId: string
  guest: Electron.WebContents
  resolveRenderer: ResolveRenderer
}): () => void {
  const { browserTabId, guest, resolveRenderer } = args
  const handler = (_event: Electron.Event, params: Electron.ContextMenuParams): void => {
    const renderer = resolveRenderer(browserTabId)
    if (!renderer) {
      return
    }
    // Why: redact the Kagi session token before pageUrl leaves main — the renderer pipes it into clipboard and shell.openExternal.
    const pageUrl = redactKagiSessionToken(guest.getURL())
    // Why: empty linkURL normalized would yield the truthy blank-page constant, showing "Open Link…" on every non-link right-click.
    const rawLinkUrl = params.linkURL || ''
    const linkUrl =
      rawLinkUrl.length > 0
        ? (normalizeExternalBrowserUrl(rawLinkUrl) ?? normalizeBrowserNavigationUrl(rawLinkUrl))
        : null
    // Why: send both viewport and screen-cursor coords; screen cursor avoids coordinate-space mismatch, guest coords are the fallback.
    const cursor = screen.getCursorScreenPoint()
    const navigationState = readGuestNavigationState(guest)
    renderer.send('browser:context-menu-requested', {
      browserPageId: browserTabId,
      x: params.x,
      y: params.y,
      screenX: cursor.x,
      screenY: cursor.y,
      pageUrl,
      linkUrl,
      // Why: forward the native selection so the renderer can Copy it directly, bypassing pages that suppress copy via oncopy handlers.
      selectionText: params.selectionText ?? '',
      ...navigationState
    })
  }

  // Why: before-mouse-event fires on every move/scroll; install the dismiss listener only while a menu is open to avoid per-event IPC.
  let dismissHandler: ((_event: Electron.Event, mouse: Electron.MouseInputEvent) => void) | null =
    null

  const removeDismissListener = (): void => {
    if (dismissHandler) {
      try {
        guest.off('before-mouse-event', dismissHandler)
      } catch {
        /* guest may already be destroyed */
      }
      dismissHandler = null
    }
  }

  const contextMenuHandler = (_event: Electron.Event, params: Electron.ContextMenuParams): void => {
    handler(_event, params)

    removeDismissListener()
    dismissHandler = (_evt: Electron.Event, mouse: Electron.MouseInputEvent): void => {
      if (mouse.type !== 'mouseDown') {
        return
      }
      // Why: a right-click mouseDown precedes a new context-menu event; dismissing here flashes the menu closed then reopens it at 0,0.
      if (mouse.button === 'right') {
        return
      }
      const renderer = resolveRenderer(browserTabId)
      if (renderer) {
        renderer.send('browser:context-menu-dismissed', { browserPageId: browserTabId })
      }
      removeDismissListener()
    }
    guest.on('before-mouse-event', dismissHandler)
  }

  guest.on('context-menu', contextMenuHandler)

  return () => {
    try {
      guest.off('context-menu', contextMenuHandler)
      removeDismissListener()
    } catch {
      // Why: browser tabs can briefly outlive the guest webContents during teardown, so cleanup is best-effort.
    }
  }
}
