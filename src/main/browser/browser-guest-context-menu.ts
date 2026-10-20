import { screen } from 'electron'
import {
  normalizeBrowserNavigationUrl,
  normalizeExternalBrowserUrl,
  redactKagiSessionToken
} from '../../shared/browser-url'
import type { BrowserContextMenuRequestedEvent } from '../../shared/browser-guest-events'
import { readContextMenuSpelling } from '../window/editable-context-menu'
import { readGuestNavigationState } from './browser-guest-navigation-state'
import type { ResolveRenderer } from './browser-guest-renderer-target'
import { buildBrowserExtensionPageContextMenu } from './extensions/browser-extension-context-menu-host'

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
    // The renderer may copy or open this URL externally; remove the Kagi token first.
    const pageUrl = redactKagiSessionToken(guest.getURL())
    // Normalizing an empty link creates a truthy blank-page URL and a spurious Open Link item.
    const rawLinkUrl = params.linkURL || ''
    const linkUrl =
      rawLinkUrl.length > 0
        ? (normalizeExternalBrowserUrl(rawLinkUrl) ?? normalizeBrowserNavigationUrl(rawLinkUrl))
        : null
    // Prefer screen coordinates to avoid viewport mismatches; retain guest coordinates as fallback.
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
      // Native selection lets Copy bypass page oncopy handlers.
      selectionText: params.selectionText ?? '',
      ...navigationState,
      editable: params.isEditable
        ? {
            canUndo: params.editFlags.canUndo,
            canRedo: params.editFlags.canRedo,
            canCut: params.editFlags.canCut,
            canCopy: params.editFlags.canCopy,
            canPaste: params.editFlags.canPaste,
            canSelectAll: params.editFlags.canSelectAll,
            spelling: readContextMenuSpelling(params)
          }
        : null,
      image:
        params.mediaType === 'image' && params.srcURL
          ? { url: params.srcURL, canCopy: params.hasImageContents }
          : null,
      extensionMenu: buildBrowserExtensionPageContextMenu(guest, params) ?? undefined
    } satisfies BrowserContextMenuRequestedEvent)
  }

  // Listen only while the menu is open to avoid per-mouse-event IPC.
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
      // Right-click precedes the next context-menu event; dismissal here would flash the menu.
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
      // The guest may already be destroyed.
    }
  }
}
