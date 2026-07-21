/* eslint-disable max-lines -- Why: single privileged bridge for guest context menus, grab-mode, and app-shortcut forwarding; splitting would blur the security boundary. */
import { screen, webContents } from 'electron'
import {
  normalizeBrowserNavigationUrl,
  normalizeExternalBrowserUrl,
  redactKagiSessionToken
} from '../../shared/browser-url'
import {
  isRecentTabSwitcherCommitRelease,
  matchesRecentTabSwitcherChord,
  nativeZoomCommandMatchesKeybindings,
  resolveWindowShortcutAction,
  type WindowShortcutInput
} from '../../shared/window-shortcut-policy'
import { readGuestNavigationState } from './browser-guest-navigation-state'
import { keybindingMatchesAction, type KeybindingOverrides } from '../../shared/keybindings'
import type { BrowserPageZoomDirection } from '../../shared/browser-page-zoom'
import {
  ModifierDoubleTapDetector,
  toModifierDoubleTapEvent
} from '../../shared/modifier-double-tap-detector'

type ResolveRenderer = (browserTabId: string) => Electron.WebContents | null
type ShouldForwardDictationShortcut = () => boolean
type IsMobileEmulatorEnabled = () => boolean

const CONTROL_MODIFIERS = new Set(['control', 'ctrl'])
const MAC_COMMAND_MODIFIERS = new Set(['meta', 'command', 'cmd'])
const WHEEL_ZOOM_BLOCKING_MODIFIERS = new Set(['alt', 'shift'])
const GUEST_WHEEL_ZOOM_DEDUPE_MS = 250

type GuestWheelZoomDirection = Exclude<BrowserPageZoomDirection, 'reset'>

const recentGuestWheelZoomByGuest = new WeakMap<
  Electron.WebContents,
  { direction: GuestWheelZoomDirection; at: number }
>()

function markGuestWheelZoom(guest: Electron.WebContents, direction: GuestWheelZoomDirection): void {
  recentGuestWheelZoomByGuest.set(guest, { direction, at: Date.now() })
}

function consumeRecentGuestWheelZoom(
  guest: Electron.WebContents,
  direction: GuestWheelZoomDirection
): boolean {
  const recent = recentGuestWheelZoomByGuest.get(guest)
  if (!recent) {
    return false
  }
  const elapsed = Date.now() - recent.at
  if (elapsed < 0 || elapsed > GUEST_WHEEL_ZOOM_DEDUPE_MS) {
    recentGuestWheelZoomByGuest.delete(guest)
    return false
  }
  if (recent.direction !== direction) {
    return false
  }
  recentGuestWheelZoomByGuest.delete(guest)
  return true
}

function hasModifier(mouse: Electron.MouseInputEvent, modifiers: ReadonlySet<string>): boolean {
  return mouse.modifiers?.some((modifier) => modifiers.has(modifier)) ?? false
}

export function resolveGuestMouseWheelZoomDirection(
  mouse: Electron.MouseInputEvent,
  platform: NodeJS.Platform = process.platform
): GuestWheelZoomDirection | null {
  if (mouse.type !== 'mouseWheel') {
    return null
  }
  if (hasModifier(mouse, WHEEL_ZOOM_BLOCKING_MODIFIERS)) {
    return null
  }
  const hasZoomModifier =
    hasModifier(mouse, CONTROL_MODIFIERS) ||
    (platform === 'darwin' && hasModifier(mouse, MAC_COMMAND_MODIFIERS))
  if (!hasZoomModifier) {
    return null
  }
  const deltaY = (mouse as Electron.MouseWheelInputEvent).deltaY
  if (typeof deltaY !== 'number' || deltaY === 0) {
    return null
  }
  return deltaY < 0 ? 'in' : 'out'
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

// Why: a focused guest never surfaces Cmd/Ctrl+C to the renderer; forward only when it wouldn't do a normal copy (no editable focus, no selection).
export function setupGrabShortcutForwarding(args: {
  browserTabId: string
  guest: Electron.WebContents
  resolveRenderer: ResolveRenderer
  hasActiveGrabOp: (browserTabId: string) => boolean
  getKeybindings?: () => KeybindingOverrides | undefined
}): () => void {
  const { browserTabId, guest, resolveRenderer, hasActiveGrabOp, getKeybindings } = args
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
      // Why: a focused guest swallows bare keys; during an active grab pick, plain C/S are Orca's copy/screenshot, not page typing.
      event.preventDefault()
      renderer.send('browser:grabActionShortcut', { browserPageId: browserTabId, key: bareKey })
      return
    }

    if (
      !keybindingMatchesAction('browser.grabElement', input, process.platform, getKeybindings?.())
    ) {
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
        // Why: shortcut forwarding is best-effort — guest teardown or a transient executeJavaScript failure must not break normal copy.
      })
  }

  guest.on('before-input-event', handler)
  return () => {
    try {
      guest.off('before-input-event', handler)
    } catch {
      // Why: browser tabs can briefly outlive the guest webContents during teardown, so cleanup is best-effort.
    }
  }
}

// Why: a focused webview guest is its own Chromium process whose key events never reach the renderer; forward shortcuts from here.
export function setupGuestShortcutForwarding(args: {
  browserTabId: string
  guest: Electron.WebContents
  resolveRenderer: ResolveRenderer
  shouldForwardDictationShortcut?: ShouldForwardDictationShortcut
  isMobileEmulatorEnabled?: IsMobileEmulatorEnabled
  getKeybindings?: () => KeybindingOverrides | undefined
}): () => void {
  const {
    browserTabId,
    guest,
    resolveRenderer,
    shouldForwardDictationShortcut,
    isMobileEmulatorEnabled,
    getKeybindings
  } = args
  let ctrlTabSwitching = false
  const doubleTapDetector = new ModifierDoubleTapDetector()
  const resetDoubleTapDetector = (): void => doubleTapDetector.reset()
  type GuestShortcutInput = WindowShortcutInput & { isAutoRepeat?: boolean }

  const forwardBrowserPageZoom = (
    event: Electron.Event,
    direction: BrowserPageZoomDirection
  ): void => {
    event.preventDefault()
    const renderer = resolveRenderer(browserTabId)
    renderer?.send('ui:zoomBrowserPage', direction)
  }

  const forwardShortcutInput = (
    event: Electron.Event,
    input: GuestShortcutInput,
    action = resolveWindowShortcutAction(input, process.platform, getKeybindings?.())
  ): boolean => {
    const keybindings = getKeybindings?.()
    if (action?.type === 'zoom') {
      // Why: focused guest key events never reach the renderer-owned webview ref that applies Orca's page zoom.
      forwardBrowserPageZoom(event, action.direction)
      return true
    }
    if (input.isAutoRepeat) {
      if (action?.type === 'dictationKeyDown' && shouldForwardDictationShortcut?.()) {
        event.preventDefault()
        return true
      }
      return false
    }
    if (action?.type === 'worktreeHistoryNavigate') {
      // Why: preventDefault unconditionally so the guest never handles Cmd+Alt+Arrow itself, even when the renderer can't be resolved.
      event.preventDefault()
      const renderer = resolveRenderer(browserTabId)
      renderer?.send('ui:worktreeHistoryNavigate', action.direction)
      return true
    }

    if (action?.type === 'toggleFloatingTerminal') {
      event.preventDefault()
      const renderer = resolveRenderer(browserTabId)
      renderer?.send('ui:toggleFloatingTerminal')
      return true
    }

    // Why: match outside the allowlist so both the new Shift binding and upgraders' seeded Alt binding reach the renderer.
    const switchAllTypesDirection = keybindingMatchesAction(
      'tab.nextAllTypes',
      input,
      process.platform,
      keybindings
    )
      ? 1
      : keybindingMatchesAction('tab.previousAllTypes', input, process.platform, keybindings)
        ? -1
        : null
    if (switchAllTypesDirection !== null) {
      event.preventDefault()
      const renderer = resolveRenderer(browserTabId)
      renderer?.send('ui:switchTabAcrossAllTypes', switchAllTypesDirection)
      return true
    }

    if (keybindingMatchesAction('tab.previousRecent', input, process.platform, keybindings)) {
      event.preventDefault()
      const renderer = resolveRenderer(browserTabId)
      renderer?.send('ui:switchRecentTab')
      return true
    }

    // Why: terminal-tab switching defaults to Ctrl+PageUp/PageDown but goes through the registry so disable/rebind still works.
    const terminalTabDirection = keybindingMatchesAction(
      'tab.nextTerminal',
      input,
      process.platform,
      keybindings
    )
      ? 1
      : keybindingMatchesAction('tab.previousTerminal', input, process.platform, keybindings)
        ? -1
        : null
    if (terminalTabDirection !== null) {
      event.preventDefault()
      const renderer = resolveRenderer(browserTabId)
      renderer?.send('ui:switchTerminalTab', terminalTabDirection)
      return true
    }

    const renderer = resolveRenderer(browserTabId)
    if (!renderer) {
      return false
    }
    if (keybindingMatchesAction('tab.newBrowser', input, process.platform, keybindings)) {
      renderer.send('ui:newBrowserTab')
    } else if (
      process.platform === 'darwin' &&
      (isMobileEmulatorEnabled?.() ?? true) &&
      keybindingMatchesAction('tab.newSimulator', input, process.platform, keybindings)
    ) {
      renderer.send('ui:newSimulatorTab')
    } else if (keybindingMatchesAction('tab.newMarkdown', input, process.platform, keybindings)) {
      renderer.send('ui:newMarkdownTab')
    } else if (keybindingMatchesAction('tab.newTerminal', input, process.platform, keybindings)) {
      // Why: Cmd/Ctrl+T opens a terminal even when a browser guest is focused (Shift+B is the new-browser-tab shortcut).
      renderer.send('ui:newTerminalTab')
    } else if (
      keybindingMatchesAction('browser.focusAddressBar', input, process.platform, keybindings)
    ) {
      // Why: the address bar lives in renderer chrome, not the guest page; forward so the active BrowserPane can focus its input.
      renderer.send('ui:focusBrowserAddressBar')
    } else if (
      keybindingMatchesAction('browser.hardReload', input, process.platform, keybindings)
    ) {
      // Why: forward hard reload so reloadIgnoringCache() runs on the renderer's parked-webview ref that owns the guest surface.
      renderer.send('ui:hardReloadBrowserPage')
    } else if (keybindingMatchesAction('browser.reload', input, process.platform, keybindings)) {
      // Why: forward soft reload so the renderer's reload() hits the parked-webview eviction the guest's built-in shortcut skips.
      renderer.send('ui:reloadBrowserPage')
    } else if (keybindingMatchesAction('browser.find', input, process.platform, keybindings)) {
      // Why: guest-native find UI is invisible behind Orca's chrome; forward so the renderer opens its own find-in-page bar.
      renderer.send('ui:findInBrowserPage')
    } else if (keybindingMatchesAction('browser.back', input, process.platform, keybindings)) {
      // Why: macOS Logitech side-button remaps arrive as history keystrokes, not mouse events; forward so the renderer can goBack().
      renderer.send('ui:browserHistoryNavigate', 'back')
    } else if (keybindingMatchesAction('browser.forward', input, process.platform, keybindings)) {
      // Why: same as browser.back; the focused guest cannot call the renderer-owned webview's goForward() directly.
      renderer.send('ui:browserHistoryNavigate', 'forward')
    } else if (keybindingMatchesAction('tab.close', input, process.platform, keybindings)) {
      renderer.send('ui:closeActiveTab')
    } else if (keybindingMatchesAction('tab.nextSameType', input, process.platform, keybindings)) {
      renderer.send('ui:switchTab', 1)
    } else if (
      keybindingMatchesAction('tab.previousSameType', input, process.platform, keybindings)
    ) {
      renderer.send('ui:switchTab', -1)
    } else if (action?.type === 'toggleWorktreePalette') {
      renderer.send('ui:toggleWorktreePalette')
    } else if (action?.type === 'openQuickOpen') {
      renderer.send('ui:openQuickOpen')
    } else if (action?.type === 'toggleQuickCommandsMenu') {
      renderer.send('ui:toggleQuickCommandsMenu')
    } else if (action?.type === 'openNewWorkspace') {
      renderer.send('ui:openNewWorkspace')
    } else if (action?.type === 'openWorkspaceBoard') {
      renderer.send('ui:openWorkspaceBoard')
    } else if (action?.type === 'openTasks') {
      renderer.send('ui:openTasks')
    } else if (action?.type === 'openSettings') {
      renderer.send('ui:openSettings')
    } else if (action?.type === 'forceReload') {
      renderer.reloadIgnoringCache()
    } else if (action?.type === 'jumpToWorktreeIndex') {
      renderer.send('ui:jumpToWorktreeIndex', action.index)
    } else if (action?.type === 'jumpToTabIndex') {
      renderer.send('ui:jumpToTabIndex', action.index)
    } else if (action?.type === 'dictationKeyDown') {
      if (!shouldForwardDictationShortcut?.()) {
        return false
      }
      renderer.send('ui:dictationKeyDown')
    } else {
      return false
    }
    // Why: preventDefault stops the guest page from also processing the chord (e.g. Cmd+T opening a browser-internal new-tab page).
    event.preventDefault()
    return true
  }

  const handler = (event: Electron.Event, input: Electron.Input): void => {
    const keybindings = getKeybindings?.()
    if (
      input.type === 'keyDown' &&
      matchesRecentTabSwitcherChord(input, process.platform, keybindings)
    ) {
      event.preventDefault()
      ctrlTabSwitching = true
      const renderer = resolveRenderer(browserTabId)
      renderer?.send('ui:ctrlTabKeyDown', { shiftKey: input.shift === true })
      return
    }

    if (ctrlTabSwitching && isRecentTabSwitcherCommitRelease(input)) {
      event.preventDefault()
      ctrlTabSwitching = false
      const renderer = resolveRenderer(browserTabId)
      renderer?.send('ui:ctrlTabKeyUp')
      return
    }

    if (input.type === 'keyDown' || input.type === 'keyUp') {
      const detected = doubleTapDetector.process(
        toModifierDoubleTapEvent({
          type: input.type,
          code: input.code,
          key: input.key,
          shift: input.shift,
          control: input.control,
          alt: input.alt,
          meta: input.meta,
          isAutoRepeat: input.isAutoRepeat
        }),
        Date.now()
      )
      if (detected) {
        const doubleTapInput: GuestShortcutInput = { doubleTapModifier: detected.modifier }
        forwardShortcutInput(
          event,
          doubleTapInput,
          resolveWindowShortcutAction(doubleTapInput, process.platform, keybindings, {
            context: 'app'
          })
        )
        return
      }
    }

    if (input.type !== 'keyDown') {
      return
    }
    // Why: Cmd/Ctrl+Alt+Arrow is the only allowlisted chord carrying Alt, so resolve it before the Alt-rejecting chord gate below.
    const action = resolveWindowShortcutAction(input, process.platform, keybindings)
    forwardShortcutInput(event, input, action)
  }

  const zoomCommandHandler = (
    event: Electron.Event,
    zoomDirection: 'in' | 'out' | 'reset'
  ): void => {
    if (zoomDirection !== 'in' && zoomDirection !== 'out') {
      return
    }
    // Why: some layouts/platforms turn Ctrl/Cmd +/- into Electron's native zoom before before-input-event reaches the guest.
    if (consumeRecentGuestWheelZoom(guest, zoomDirection)) {
      event.preventDefault()
      return
    }
    if (!nativeZoomCommandMatchesKeybindings(zoomDirection, process.platform, getKeybindings?.())) {
      return
    }
    forwardBrowserPageZoom(event, zoomDirection)
  }

  guest.on('before-input-event', handler)
  guest.on('zoom-changed', zoomCommandHandler)
  guest.on('blur', resetDoubleTapDetector)
  return () => {
    try {
      guest.off('before-input-event', handler)
      guest.off('zoom-changed', zoomCommandHandler)
      guest.off('blur', resetDoubleTapDetector)
    } catch {
      // Why: best-effort — guest may already be destroyed during teardown.
    }
  }
}

export function setupGuestMouseWheelZoomForwarding(args: {
  browserTabId: string
  guest: Electron.WebContents
  resolveRenderer: ResolveRenderer
}): () => void {
  const { browserTabId, guest, resolveRenderer } = args
  const handler = (event: Electron.Event, mouse: Electron.MouseInputEvent): void => {
    const direction = resolveGuestMouseWheelZoomDirection(mouse)
    if (!direction) {
      return
    }
    // Why: wheel input over a focused webview never reaches renderer DOM handlers, so consume and forward here.
    event.preventDefault()
    markGuestWheelZoom(guest, direction)
    resolveRenderer(browserTabId)?.send('ui:zoomBrowserPage', direction)
  }

  guest.on('before-mouse-event', handler)
  return () => {
    try {
      guest.off('before-mouse-event', handler)
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
