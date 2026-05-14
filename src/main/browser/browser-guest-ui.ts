import { screen, webContents } from 'electron'
import {
  normalizeBrowserNavigationUrl,
  normalizeExternalBrowserUrl,
  redactKagiSessionToken
} from '../../shared/browser-url'
import {
  isWindowShortcutModifierChord,
  resolveWindowShortcutAction
} from '../../shared/window-shortcut-policy'

type ResolveRenderer = (browserTabId: string) => Electron.WebContents | null
type ShouldForwardDictationShortcut = () => boolean

function isTerminalTabSwitchChord(input: Electron.Input): boolean {
  return (
    Boolean(input.control) &&
    !input.meta &&
    !input.alt &&
    !input.shift &&
    (input.code === 'PageDown' || input.code === 'PageUp')
  )
}

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
    // Why: redact Kagi session tokens before the URL leaves main; the renderer
    // pipes pageUrl into clipboard writes and shell.openExternal, both of which
    // would otherwise expose the bearer token outside Orca.
    const pageUrl = redactKagiSessionToken(guest.getURL())
    // Why: params.linkURL is empty when the user right-clicks non-link
    // content. Normalizing an empty string through normalizeBrowserNavigationUrl
    // produces the blank-page constant (a truthy string), which would trick the
    // renderer into showing "Open Link…" items for every right-click.
    const rawLinkUrl = params.linkURL || ''
    const linkUrl =
      rawLinkUrl.length > 0
        ? (normalizeExternalBrowserUrl(rawLinkUrl) ?? normalizeBrowserNavigationUrl(rawLinkUrl))
        : null
    // Why: send BOTH the guest viewport coordinates AND the OS screen cursor
    // position. The renderer will try the screen cursor approach (which is
    // immune to guest/renderer coordinate space mismatches) and fall back to
    // guest coords if the screen API is unavailable.
    const cursor = screen.getCursorScreenPoint()
    renderer.send('browser:context-menu-requested', {
      browserPageId: browserTabId,
      x: params.x,
      y: params.y,
      screenX: cursor.x,
      screenY: cursor.y,
      pageUrl,
      linkUrl,
      canGoBack: guest.canGoBack(),
      canGoForward: guest.canGoForward()
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
      // Why: a right-click mouseDown will be followed by a new context-menu
      // event with updated coordinates. Sending a dismiss here would cause
      // the renderer to briefly close the menu (trigger snaps to 0,0) then
      // reopen it, producing a visible flash at the top-left corner.
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
  shouldForwardDictationShortcut?: ShouldForwardDictationShortcut
}): () => void {
  const { browserTabId, guest, resolveRenderer, shouldForwardDictationShortcut } = args
  const handler = (event: Electron.Event, input: Electron.Input): void => {
    if (input.type !== 'keyDown') {
      return
    }
    // Why: resolve the policy action once per keystroke. The history-navigate
    // chord (Cmd/Ctrl+Alt+Arrow) is the only allowlisted chord that carries
    // Alt and must be handled before the generic modifier-chord gate below,
    // which rejects Alt. Every other chord handled further down can reuse
    // the same `action` rather than re-running the full predicate chain.
    const action = resolveWindowShortcutAction(input, process.platform)
    if (input.isAutoRepeat) {
      if (action?.type === 'dictationKeyDown' && shouldForwardDictationShortcut?.()) {
        event.preventDefault()
      }
      return
    }
    if (action?.type === 'worktreeHistoryNavigate') {
      // Why: preventDefault unconditionally — if we cannot resolve the
      // renderer (torn-down tab or teardown race), dropping the keystroke
      // into the guest's webContents would let Chromium / the guest page
      // handle Cmd+Alt+Arrow as their own chord (e.g. guest-side text
      // navigation). Consistency with the main-window path is preserved
      // only by suppressing the event here too.
      event.preventDefault()
      const renderer = resolveRenderer(browserTabId)
      renderer?.send('ui:worktreeHistoryNavigate', action.direction)
      return
    }

    if (action?.type === 'toggleFloatingTerminal') {
      event.preventDefault()
      const renderer = resolveRenderer(browserTabId)
      renderer?.send('ui:toggleFloatingTerminal')
      return
    }

    // Why: Cmd/Ctrl+Alt+[ / ] cycles across every tab type. Handled before
    // the generic modifier-chord gate below because that gate rejects Alt.
    // Mirrors the Alt-exempt branch pattern used for worktreeHistoryNavigate.
    const isPrimaryMod =
      process.platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
    if (
      isPrimaryMod &&
      input.alt &&
      (input.code === 'BracketRight' || input.code === 'BracketLeft')
    ) {
      event.preventDefault()
      const renderer = resolveRenderer(browserTabId)
      renderer?.send('ui:switchTabAcrossAllTypes', input.code === 'BracketRight' ? 1 : -1)
      return
    }

    // Why: terminal-only tab switching is intentionally Ctrl+PageUp/PageDown on
    // every platform. Handle it before the primary-modifier gate so macOS Ctrl
    // (non-primary there) still forwards out of focused browser guests.
    if (isTerminalTabSwitchChord(input)) {
      event.preventDefault()
      const renderer = resolveRenderer(browserTabId)
      renderer?.send('ui:switchTerminalTab', input.code === 'PageDown' ? 1 : -1)
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

    if (input.code === 'KeyB' && input.shift) {
      renderer.send('ui:newBrowserTab')
    } else if (input.code === 'KeyT' && !input.shift) {
      // Why: Cmd/Ctrl+T always opens a new terminal in the central pane,
      // even when focus is inside a browser guest. Cmd/Ctrl+Shift+B is the
      // dedicated shortcut for new browser tabs.
      renderer.send('ui:newTerminalTab')
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
    } else if (action?.type === 'openNewWorkspace') {
      renderer.send('ui:openNewWorkspace')
    } else if (action?.type === 'jumpToWorktreeIndex') {
      renderer.send('ui:jumpToWorktreeIndex', action.index)
    } else if (action?.type === 'dictationKeyDown') {
      if (!shouldForwardDictationShortcut?.()) {
        return
      }
      renderer.send('ui:dictationKeyDown')
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
