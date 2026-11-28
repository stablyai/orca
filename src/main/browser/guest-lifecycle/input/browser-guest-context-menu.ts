import { screen } from 'electron'
import type { BrowserContextMenuRequestedEvent } from '../../../../shared/browser/guest-lifecycle/browser-guest-events'
import {
  isContextMenuFromInjectedPress,
  readGuestContextMenuTarget
} from './browser-guest-context-menu-target'
import type { ResolveRenderer } from '../browser-guest-renderer-target'
// oxlint-disable-next-line import/no-cycle -- browser subsystem singleton hub (browserManager); breaking it needs DI and test-mock updates, left for a human
import { buildBrowserExtensionPageContextMenu } from '../../extensions/context-menus/browser-extension-context-menu-host'

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
    // Prefer screen coordinates to avoid viewport mismatches; retain guest coordinates as fallback.
    const cursor = screen.getCursorScreenPoint()
    renderer.send('browser:context-menu-requested', {
      ...readGuestContextMenuTarget(guest, params),
      browserPageId: browserTabId,
      screenX: cursor.x,
      screenY: cursor.y,
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
    // An agent's or remote viewer's right-click must not open a menu over this desktop's user.
    if (isContextMenuFromInjectedPress(guest)) {
      return
    }
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
