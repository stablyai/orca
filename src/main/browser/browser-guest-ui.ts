/* eslint-disable max-lines -- Why: focused guest hooks share teardown and
shortcut-forwarding invariants that are easier to audit together. */
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
import { resolveKeybindingAction } from '../../shared/keybindings/effective-keymap'
import type { EffectiveKeymap, KeybindingCommand } from '../../shared/keybindings/keybinding-types'

type ResolveRenderer = (browserTabId: string) => Electron.WebContents | null

function isTerminalTabSwitchChord(input: Electron.Input): boolean {
  return (
    Boolean(input.control) &&
    !input.meta &&
    !input.alt &&
    !input.shift &&
    (input.code === 'PageDown' || input.code === 'PageUp')
  )
}

type BrowserGuestShortcutForward =
  | { channel: 'ui:worktreeHistoryNavigate'; args: ['back' | 'forward'] }
  | { channel: 'ui:toggleFloatingTerminal'; args?: [] }
  | { channel: 'ui:switchTabAcrossAllTypes'; args: [1 | -1] }
  | { channel: 'ui:switchTerminalTab'; args: [1 | -1] }
  | { channel: 'ui:newBrowserTab'; args?: [] }
  | { channel: 'ui:newTerminalTab'; args?: [] }
  | { channel: 'ui:focusBrowserAddressBar'; args?: [] }
  | { channel: 'ui:hardReloadBrowserPage'; args?: [] }
  | { channel: 'ui:reloadBrowserPage'; args?: [] }
  | { channel: 'ui:findInBrowserPage'; args?: [] }
  | { channel: 'ui:closeActiveTab'; args?: [] }
  | { channel: 'ui:switchTab'; args: [1 | -1] }
  | { channel: 'ui:toggleWorktreePalette'; args?: [] }
  | { channel: 'ui:openQuickOpen'; args?: [] }
  | { channel: 'ui:openNewWorkspace'; args?: [] }
  | { channel: 'ui:jumpToWorktreeIndex'; args: [number] }

function sendBrowserGuestShortcut(
  renderer: Electron.WebContents | null,
  forward: BrowserGuestShortcutForward
): void {
  renderer?.send(forward.channel, ...(forward.args ?? []))
}

function resolveBrowserGuestShortcut(
  input: Electron.Input,
  keymap?: EffectiveKeymap
): BrowserGuestShortcutForward | null {
  if (keymap) {
    const action = resolveKeybindingAction(
      keymap,
      {
        key: input.key ?? '',
        code: input.code,
        metaKey: Boolean(input.meta),
        ctrlKey: Boolean(input.control),
        altKey: Boolean(input.alt),
        shiftKey: Boolean(input.shift)
      },
      'browserGuest'
    )
    return action ? browserGuestCommandToForward(action.command) : null
  }

  return resolveLegacyBrowserGuestShortcut(input)
}

function resolveLegacyBrowserGuestShortcut(
  input: Electron.Input
): BrowserGuestShortcutForward | null {
  const action = resolveWindowShortcutAction(input, process.platform)
  if (action?.type === 'worktreeHistoryNavigate') {
    return { channel: 'ui:worktreeHistoryNavigate', args: [action.direction] }
  }

  if (action?.type === 'toggleFloatingTerminal') {
    return { channel: 'ui:toggleFloatingTerminal' }
  }

  const isPrimaryMod =
    process.platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
  if (
    isPrimaryMod &&
    input.alt &&
    (input.code === 'BracketRight' || input.code === 'BracketLeft')
  ) {
    return {
      channel: 'ui:switchTabAcrossAllTypes',
      args: [input.code === 'BracketRight' ? 1 : -1]
    }
  }

  if (isTerminalTabSwitchChord(input)) {
    return { channel: 'ui:switchTerminalTab', args: [input.code === 'PageDown' ? 1 : -1] }
  }

  if (!isWindowShortcutModifierChord(input, process.platform)) {
    return null
  }

  if (input.code === 'KeyB' && input.shift) {
    return { channel: 'ui:newBrowserTab' }
  }
  if (input.code === 'KeyT' && !input.shift) {
    return { channel: 'ui:newTerminalTab' }
  }
  if (input.code === 'KeyL' && !input.shift) {
    return { channel: 'ui:focusBrowserAddressBar' }
  }
  if (input.code === 'KeyR' && input.shift) {
    return { channel: 'ui:hardReloadBrowserPage' }
  }
  if (input.code === 'KeyR' && !input.shift) {
    return { channel: 'ui:reloadBrowserPage' }
  }
  if (input.code === 'KeyF' && !input.shift) {
    return { channel: 'ui:findInBrowserPage' }
  }
  if (input.code === 'KeyW' && !input.shift) {
    return { channel: 'ui:closeActiveTab' }
  }
  if (input.shift && (input.code === 'BracketRight' || input.code === 'BracketLeft')) {
    return { channel: 'ui:switchTab', args: [input.code === 'BracketRight' ? 1 : -1] }
  }
  if (action?.type === 'toggleWorktreePalette') {
    return { channel: 'ui:toggleWorktreePalette' }
  }
  if (action?.type === 'openQuickOpen') {
    return { channel: 'ui:openQuickOpen' }
  }
  if (action?.type === 'openNewWorkspace') {
    return { channel: 'ui:openNewWorkspace' }
  }
  if (action?.type === 'jumpToWorktreeIndex') {
    return { channel: 'ui:jumpToWorktreeIndex', args: [action.index] }
  }

  return null
}

function browserGuestCommandToForward(
  command: KeybindingCommand
): BrowserGuestShortcutForward | null {
  switch (command.type) {
    case 'worktreeHistoryNavigate':
      return { channel: 'ui:worktreeHistoryNavigate', args: [command.direction] }
    case 'toggleFloatingTerminal':
      return { channel: 'ui:toggleFloatingTerminal' }
    case 'switchTabAcrossAllTypes':
      return {
        channel: 'ui:switchTabAcrossAllTypes',
        args: [command.direction === 'next' ? 1 : -1]
      }
    case 'switchTerminalTab':
      return { channel: 'ui:switchTerminalTab', args: [command.direction === 'next' ? 1 : -1] }
    case 'openNewBrowserTab':
      return { channel: 'ui:newBrowserTab' }
    case 'openNewTerminalTab':
      return { channel: 'ui:newTerminalTab' }
    case 'focusBrowserAddressBar':
      return { channel: 'ui:focusBrowserAddressBar' }
    case 'hardReloadBrowserPage':
      return { channel: 'ui:hardReloadBrowserPage' }
    case 'reloadBrowserPage':
      return { channel: 'ui:reloadBrowserPage' }
    case 'findInBrowserPage':
      return { channel: 'ui:findInBrowserPage' }
    case 'closeActiveTab':
      return { channel: 'ui:closeActiveTab' }
    case 'switchTab':
      return { channel: 'ui:switchTab', args: [command.direction === 'next' ? 1 : -1] }
    case 'toggleWorktreePalette':
      return { channel: 'ui:toggleWorktreePalette' }
    case 'openQuickOpen':
      return { channel: 'ui:openQuickOpen' }
    case 'openNewWorkspace':
      return { channel: 'ui:openNewWorkspace' }
    case 'jumpToWorktreeIndex':
      return { channel: 'ui:jumpToWorktreeIndex', args: [command.index] }
    default:
      return null
  }
}

function isBrowserGrabModeToggleShortcut(input: Electron.Input, keymap?: EffectiveKeymap): boolean {
  if (keymap) {
    const action = resolveKeybindingAction(
      keymap,
      {
        key: input.key ?? '',
        code: input.code,
        metaKey: Boolean(input.meta),
        ctrlKey: Boolean(input.control),
        altKey: Boolean(input.alt),
        shiftKey: Boolean(input.shift)
      },
      'browserGuest'
    )
    return action?.command.type === 'toggleBrowserGrabMode'
  }

  const isMod = process.platform === 'darwin' ? input.meta : input.control
  const bareKey = input.key.toLowerCase()
  return Boolean(isMod) && !input.shift && !input.alt && bareKey === 'c'
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
  getEffectiveKeymap?: () => EffectiveKeymap
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

    if (!isBrowserGrabModeToggleShortcut(input, args.getEffectiveKeymap?.())) {
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
  getEffectiveKeymap?: () => EffectiveKeymap
}): () => void {
  const { browserTabId, guest, resolveRenderer, getEffectiveKeymap } = args
  const handler = (event: Electron.Event, input: Electron.Input): void => {
    if (input.type !== 'keyDown') {
      return
    }
    const forward = resolveBrowserGuestShortcut(input, getEffectiveKeymap?.())
    if (!forward) {
      return
    }
    // Why: preventDefault stops the guest page from also processing the chord
    // (e.g. Cmd+T opening a browser-internal new-tab page).
    event.preventDefault()
    sendBrowserGuestShortcut(resolveRenderer(browserTabId), forward)
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
