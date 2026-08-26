import {
  resolveWindowShortcutAction,
  type WindowShortcutInput
} from '../../shared/window-shortcut-policy'
import { keybindingMatchesAction, type KeybindingOverrides } from '../../shared/keybindings'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import type { BrowserPageZoomDirection } from '../../shared/browser-page-zoom'
import type { BrowserFindTarget } from '../../shared/browser-find-source'
import type { ResolveRenderer } from './browser-guest-renderer-target'

export type ShouldForwardDictationShortcut = () => boolean
export type IsMobileEmulatorEnabled = () => boolean
export type GuestShortcutInput = WindowShortcutInput & { isAutoRepeat?: boolean }

export type GuestShortcutForwardContext = {
  browserTabId: string
  resolveRenderer: ResolveRenderer
  shouldForwardDictationShortcut?: ShouldForwardDictationShortcut
  isMobileEmulatorEnabled?: IsMobileEmulatorEnabled
  getKeybindings?: () => KeybindingOverrides | undefined
  resolveWorktreeId?: (browserTabId: string) => string | null
  resolveWorkspaceId?: (browserTabId: string) => string | null
  forwardBrowserPageZoom: (event: Electron.Event, direction: BrowserPageZoomDirection) => void
}

export function forwardGuestShortcutInput(
  ctx: GuestShortcutForwardContext,
  event: Electron.Event,
  input: GuestShortcutInput,
  action = resolveWindowShortcutAction(input, process.platform, ctx.getKeybindings?.())
): boolean {
  const {
    browserTabId,
    resolveRenderer,
    shouldForwardDictationShortcut,
    isMobileEmulatorEnabled,
    getKeybindings,
    resolveWorktreeId,
    resolveWorkspaceId,
    forwardBrowserPageZoom
  } = ctx
  const keybindings = getKeybindings?.()
  if (action?.type === 'zoom') {
    // Why: focused guest key events never reach the renderer-owned webview ref that applies Orca's page zoom.
    forwardBrowserPageZoom(event, action.direction)
    return true
  }
  if (input.isAutoRepeat) {
    if (
      (action?.type === 'dictationKeyDown' && shouldForwardDictationShortcut?.()) ||
      action?.type === 'deleteCurrentWorkspace'
    ) {
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
  // Why: floating-panel guests route close/index chords to the panel (carrying their source id) so they hit the floating workspace, not the main tab strip.
  const isFloatingGuest = resolveWorktreeId?.(browserTabId) === FLOATING_TERMINAL_WORKTREE_ID
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
  } else if (keybindingMatchesAction('browser.hardReload', input, process.platform, keybindings)) {
    // Why: forward hard reload so reloadIgnoringCache() runs on the renderer's parked-webview ref that owns the guest surface.
    renderer.send('ui:hardReloadBrowserPage')
  } else if (keybindingMatchesAction('browser.reload', input, process.platform, keybindings)) {
    // Why: forward soft reload so the renderer's reload() hits the parked-webview eviction the guest's built-in shortcut skips.
    renderer.send('ui:reloadBrowserPage')
  } else if (keybindingMatchesAction('browser.find', input, process.platform, keybindings)) {
    // Why: active browser splits share one renderer; preserve the registered guest owner so only
    // its Find bar opens. A client-hosted guest has no registered workspace, and dropping the
    // chord there both suppressed it in the guest and delivered nothing.
    const browserWorkspaceId = resolveWorkspaceId?.(browserTabId) || undefined
    const target: BrowserFindTarget = { browserPageId: browserTabId, browserWorkspaceId }
    renderer.send('ui:findInBrowserPage', target)
  } else if (keybindingMatchesAction('browser.back', input, process.platform, keybindings)) {
    // Why: macOS Logitech side-button remaps arrive as history keystrokes, not mouse events; forward so the renderer can goBack().
    renderer.send('ui:browserHistoryNavigate', 'back')
  } else if (keybindingMatchesAction('browser.forward', input, process.platform, keybindings)) {
    // Why: same as browser.back; the focused guest cannot call the renderer-owned webview's goForward() directly.
    renderer.send('ui:browserHistoryNavigate', 'forward')
  } else if (keybindingMatchesAction('tab.close', input, process.platform, keybindings)) {
    if (isFloatingGuest) {
      renderer.send('ui:closeFloatingItem', { sourceId: browserTabId })
    } else {
      renderer.send('ui:closeActiveTab')
    }
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
  } else if (action?.type === 'deleteCurrentWorkspace') {
    renderer.send('ui:deleteCurrentWorkspace')
  } else if (action?.type === 'openWorkspaceBoard') {
    renderer.send('ui:openWorkspaceBoard')
  } else if (action?.type === 'openTasks') {
    renderer.send('ui:openTasks')
  } else if (action?.type === 'toggleAgentDashboard') {
    renderer.send('ui:toggleAgentDashboard')
  } else if (action?.type === 'openSettings') {
    renderer.send('ui:openSettings')
  } else if (action?.type === 'forceReload') {
    renderer.reloadIgnoringCache()
  } else if (action?.type === 'jumpToWorktreeIndex') {
    if (isFloatingGuest) {
      renderer.send('ui:selectFloatingIndex', { index: action.index })
    } else {
      renderer.send('ui:jumpToWorktreeIndex', action.index)
    }
  } else if (action?.type === 'jumpToTabIndex') {
    if (isFloatingGuest) {
      renderer.send('ui:selectFloatingIndex', { index: action.index })
    } else {
      renderer.send('ui:jumpToTabIndex', action.index)
    }
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
