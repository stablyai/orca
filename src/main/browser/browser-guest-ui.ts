import { webContents } from 'electron'
import {
  normalizeBrowserNavigationUrl,
  normalizeExternalBrowserUrl
} from '../../shared/browser-url'
import {
  isWindowShortcutModifierChord,
  resolveWindowShortcutAction
} from '../../shared/window-shortcut-policy'

type ResolveRenderer = (browserTabId: string) => Electron.WebContents | null

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
    const pageUrl = guest.getURL()
    // Why: params.linkURL is empty when the user right-clicks non-link
    // content. Normalizing an empty string through normalizeBrowserNavigationUrl
    // produces the blank-page constant (a truthy string), which would trick the
    // renderer into showing "Open Link…" items for every right-click.
    const rawLinkUrl = params.linkURL || ''
    const linkUrl =
      rawLinkUrl.length > 0
        ? (normalizeExternalBrowserUrl(rawLinkUrl) ?? normalizeBrowserNavigationUrl(rawLinkUrl))
        : null
    const sendContextMenu = (viewportX: number, viewportY: number): void => {
      renderer.send('browser:context-menu-requested', {
        browserPageId: browserTabId,
        x: viewportX,
        y: viewportY,
        pageUrl,
        linkUrl,
        canGoBack: guest.canGoBack(),
        canGoForward: guest.canGoForward()
      })
    }

    // Why: Electron reports guest context-menu coordinates in page space.
    // Orca's renderer-owned menu needs viewport-relative coordinates so the
    // menu appears under the cursor even after the page has scrolled.
    if (typeof guest.executeJavaScript !== 'function') {
      // Why: some tests and rare teardown edges only expose a minimal
      // WebContents shape. Falling back to raw coordinates keeps the menu
      // request best-effort instead of hard-failing on missing helpers.
      sendContextMenu(params.x, params.y)
      return
    }

    void guest
      .executeJavaScript('({ scrollX: window.scrollX, scrollY: window.scrollY })', true)
      .then((scroll) => {
        const scrollX =
          typeof scroll === 'object' && scroll && 'scrollX' in scroll
            ? Number((scroll as { scrollX: unknown }).scrollX) || 0
            : 0
        const scrollY =
          typeof scroll === 'object' && scroll && 'scrollY' in scroll
            ? Number((scroll as { scrollY: unknown }).scrollY) || 0
            : 0
        sendContextMenu(params.x - scrollX, params.y - scrollY)
      })
      .catch(() => {
        // Why: if the guest is tearing down, best-effort fallback to the raw
        // coordinates is better than dropping the Orca menu entirely.
        sendContextMenu(params.x, params.y)
      })
  }

  // Why: `before-mouse-event` fires for every mouse event (move, down, up,
  // scroll) on the guest. Installing the dismiss listener only while a context
  // menu is open avoids an IPC dispatch per mouse event on idle guests.
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
      // Why: browser tabs can outlive the guest webContents briefly during
      // teardown. Cleanup should be best-effort instead of throwing while the
      // IDE is closing a tab.
    }
  }
}

// Why: browser grab mode intentionally uses Cmd/Ctrl+C as its entry
// gesture, but a focused webview guest is a separate Chromium process so
// the renderer's window-level keydown handler never sees that shortcut.
// Only forward the chord when Chromium would not perform a normal copy:
// no editable element is focused and there is no selected text. That keeps
// native page copy working while still making the grab shortcut reachable
// from focused web content.
export function setupGrabShortcutForwarding(args: {
  browserTabId: string
  guest: Electron.WebContents
  resolveRenderer: ResolveRenderer
  hasActiveGrabOp: (browserTabId: string) => boolean
}): () => void {
  const { browserTabId, guest, resolveRenderer, hasActiveGrabOp } = args
  const handler = (event: Electron.Event, input: Electron.Input): void => {
    if (input.type !== 'keyDown') {
      return
    }
    const bareKey = input.key.toLowerCase()
    if (
      !input.meta &&
      !input.control &&
      !input.alt &&
      !input.shift &&
      (bareKey === 'c' || bareKey === 's') &&
      hasActiveGrabOp(browserTabId)
    ) {
      const renderer = resolveRenderer(browserTabId)
      if (!renderer) {
        return
      }
      // Why: a focused guest swallows bare keys before the renderer sees them.
      // While grab mode is actively awaiting a pick, plain C/S belong to Orca's
      // copy/screenshot shortcuts rather than the page's typing behavior.
      event.preventDefault()
      renderer.send('browser:grabActionShortcut', { browserPageId: browserTabId, key: bareKey })
      return
    }

    const isMod = process.platform === 'darwin' ? input.meta : input.control
    if (!isMod || input.shift || input.alt || bareKey !== 'c') {
      return
    }

    void guest
      .executeJavaScript(`(() => {
        const active = document.activeElement
        const tag = active?.tagName
        const isEditable =
          active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement ||
          active?.isContentEditable === true ||
          tag === 'SELECT' ||
          tag === 'IFRAME'
        if (isEditable) {
          return false
        }
        const selection = window.getSelection()
        return Boolean(selection && selection.type === 'Range' && selection.toString().trim().length > 0)
          ? false
          : true
      })()`)
      .then((shouldToggle) => {
        if (!shouldToggle) {
          return
        }
        event.preventDefault()
        const renderer = resolveRenderer(browserTabId)
        if (!renderer) {
          return
        }
        renderer.send('browser:grabModeToggle', browserTabId)
      })
      .catch(() => {
        // Why: shortcut forwarding is best-effort. Guest teardown or a
        // transient executeJavaScript failure should not break normal copy.
      })
  }

  guest.on('before-input-event', handler)
  return () => {
    try {
      guest.off('before-input-event', handler)
    } catch {
      // Why: browser tabs can outlive the guest webContents briefly during
      // teardown. Cleanup should be best-effort.
    }
  }
}

// Why: a focused webview guest is a separate Chromium process — keyboard
// events go to the guest's own webContents and never fire the renderer's
// window-level keydown handler or the main window's before-input-event.
// Intercept common app shortcuts on the guest and forward them to the
// renderer so they work consistently regardless of which surface has focus.
export function setupGuestShortcutForwarding(args: {
  browserTabId: string
  guest: Electron.WebContents
  resolveRenderer: ResolveRenderer
}): () => void {
  const { browserTabId, guest, resolveRenderer } = args
  const handler = (event: Electron.Event, input: Electron.Input): void => {
    if (input.type !== 'keyDown') {
      return
    }
    // Why: browser guests need a broader modifier-chord gate than the main
    // window because they also forward guest-specific tab shortcuts
    // (Cmd/Ctrl+T/W/Shift+B/Shift+[ / ]) in addition to the shared allowlist
    // handled by resolveWindowShortcutAction().
    if (!isWindowShortcutModifierChord(input, process.platform)) {
      return
    }

    const renderer = resolveRenderer(browserTabId)
    if (!renderer) {
      return
    }

    // Why: centralizing the shared subset still keeps guest forwarding in
    // lockstep with the main window for the chords that must never steal
    // readline control input above the terminal.
    const action = resolveWindowShortcutAction(input, process.platform)

    if (input.code === 'KeyB' && input.shift) {
      renderer.send('ui:newBrowserTab')
    } else if (input.code === 'KeyT' && !input.shift) {
      // Why: once focus is inside a browser guest, Cmd/Ctrl+T should extend
      // the current browser workspace with another internal page instead of
      // creating a sibling Orca terminal tab. The renderer still decides
      // whether that means "new page in this workspace" or "new workspace"
      // based on the current active surface.
      renderer.send('ui:newBrowserTab')
    } else if (input.code === 'KeyL' && !input.shift) {
      // Why: the address bar lives in the renderer chrome, not the guest
      // page. Forward Cmd/Ctrl+L out of the guest so the active BrowserPane
      // can focus its own input just like a standalone browser would.
      renderer.send('ui:focusBrowserAddressBar')
    } else if (input.code === 'KeyR' && input.shift) {
      // Why: Cmd/Ctrl+Shift+R is the browser convention for hard reload
      // (bypass cache). The guest would handle it natively, but Orca's webview
      // reloadIgnoringCache() call must come from the renderer side so it goes
      // through the same parked-webview ref that owns the guest surface.
      renderer.send('ui:hardReloadBrowserPage')
    } else if (input.code === 'KeyR' && !input.shift) {
      // Why: same as above for soft reload — Cmd/Ctrl+R must be forwarded so
      // the renderer can call reload() on its own webview ref rather than
      // relying on the guest's built-in shortcut, which may not reach the
      // parked-webview eviction logic.
      renderer.send('ui:reloadBrowserPage')
    } else if (input.code === 'KeyF' && !input.shift) {
      // Why: Cmd/Ctrl+F must be forwarded out of the guest so the renderer can
      // open its own find-in-page bar and call webview.findInPage(). Letting the
      // guest handle it natively would open Chromium's built-in find UI inside
      // the guest frame, which is invisible behind Orca's chrome.
      renderer.send('ui:findInBrowserPage')
    } else if (input.code === 'KeyW' && !input.shift) {
      renderer.send('ui:closeActiveTab')
    } else if (input.shift && (input.code === 'BracketRight' || input.code === 'BracketLeft')) {
      renderer.send('ui:switchTab', input.code === 'BracketRight' ? 1 : -1)
    } else if (action?.type === 'toggleWorktreePalette') {
      renderer.send('ui:toggleWorktreePalette')
    } else if (action?.type === 'openQuickOpen') {
      renderer.send('ui:openQuickOpen')
    } else if (action?.type === 'jumpToWorktreeIndex') {
      renderer.send('ui:jumpToWorktreeIndex', action.index)
    } else {
      return
    }
    // Why: preventDefault stops the guest page from also processing the chord
    // (e.g. Cmd+T opening a browser-internal new-tab page).
    event.preventDefault()
  }

  guest.on('before-input-event', handler)
  return () => {
    try {
      guest.off('before-input-event', handler)
    } catch {
      // Why: best-effort — guest may already be destroyed during teardown.
    }
  }
}

export function resolveRendererWebContents(
  rendererWebContentsIdByTabId: ReadonlyMap<string, number>,
  browserTabId: string
): Electron.WebContents | null {
  const rendererWcId = rendererWebContentsIdByTabId.get(browserTabId)
  if (!rendererWcId) {
    return null
  }
  const renderer = webContents.fromId(rendererWcId)
  if (!renderer || renderer.isDestroyed()) {
    return null
  }
  return renderer
}
