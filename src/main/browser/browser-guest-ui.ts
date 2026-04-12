import { clipboard, Menu, webContents } from 'electron'
import { normalizeExternalBrowserUrl } from '../../shared/browser-url'
import {
  isWindowShortcutModifierChord,
  resolveWindowShortcutAction
} from '../../shared/window-shortcut-policy'

type ResolveRenderer = (browserTabId: string) => Electron.WebContents | null

export function setupGuestContextMenu(args: {
  browserTabId: string
  guest: Electron.WebContents
  openValidatedExternal: (rawUrl: string) => void
  openDevTools: (browserTabId: string) => Promise<boolean>
}): () => void {
  const { browserTabId, guest, openValidatedExternal, openDevTools } = args
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
            openValidatedExternal(linkUrl)
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
          openValidatedExternal(pageUrl)
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
          void openDevTools(browserTabId)
        }
      }
    )

    Menu.buildFromTemplate(template).popup()
  }

  guest.on('context-menu', handler)
  return () => {
    try {
      guest.off('context-menu', handler)
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
      renderer.send('browser:grabActionShortcut', { browserTabId, key: bareKey })
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
      renderer.send('ui:newTerminalTab')
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
