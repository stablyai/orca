import {
  resolveWindowShortcutAction,
  type WindowShortcutInput
} from '../../shared/window-shortcut-policy'
import { keybindingMatchesAction, type KeybindingOverrides } from '../../shared/keybindings'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import type { BrowserPageZoomDirection } from '../../shared/browser-page-zoom'
import type { BrowserFindTarget } from '../../shared/browser-find-source'
import type { BrowserPageTabShortcut } from '../../shared/browser-page-command-target'
import type { ResolveRenderer } from './browser-guest-renderer-target'
import { matchesGuestTabShortcut } from './browser-guest-tab-shortcut'

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
  supportsAnnotations?: (browserTabId: string) => boolean
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
    supportsAnnotations,
    forwardBrowserPageZoom
  } = ctx
  const keybindings = getKeybindings?.()
  if (action?.type === 'zoom') {
    forwardBrowserPageZoom(event, action.direction)
    return true
  }
  if (input.isAutoRepeat) {
    if (
      (action?.type === 'dictationKeyDown' && shouldForwardDictationShortcut?.()) ||
      action?.type === 'deleteCurrentWorkspace' ||
      // Why: Orca claims a held tab chord on every repeat but acts once, so repeats never reach the page.
      matchesGuestTabShortcut(
        input,
        process.platform,
        keybindings,
        isMobileEmulatorEnabled?.() ?? true
      )
    ) {
      event.preventDefault()
      return true
    }
    return false
  }
  if (action?.type === 'worktreeHistoryNavigate') {
    // Suppress guest history handling even if no renderer can be resolved.
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

  if (keybindingMatchesAction('tab.previousRecent', input, process.platform, keybindings)) {
    event.preventDefault()
    const renderer = resolveRenderer(browserTabId)
    renderer?.send('ui:switchRecentTab')
    return true
  }

  const renderer = resolveRenderer(browserTabId)
  if (!renderer) {
    return false
  }
  // Route floating guests to their own workspace for close/index shortcuts.
  const isFloatingGuest = resolveWorktreeId?.(browserTabId) === FLOATING_TERMINAL_WORKTREE_ID
  if (keybindingMatchesAction('browser.focusAddressBar', input, process.platform, keybindings)) {
    renderer.send('ui:focusBrowserAddressBar', { browserPageId: browserTabId })
  } else if (keybindingMatchesAction('browser.showHistory', input, process.platform, keybindings)) {
    renderer.send('ui:showBrowserHistory', { browserPageId: browserTabId })
  } else if (keybindingMatchesAction('browser.hardReload', input, process.platform, keybindings)) {
    // The renderer owns the parked webview used for reload.
    renderer.send('ui:hardReloadBrowserPage', { browserPageId: browserTabId })
  } else if (keybindingMatchesAction('browser.reload', input, process.platform, keybindings)) {
    // Renderer reload also handles parked-webview eviction.
    renderer.send('ui:reloadBrowserPage', { browserPageId: browserTabId })
  } else if (keybindingMatchesAction('browser.find', input, process.platform, keybindings)) {
    // Target the owning split; client-hosted guests can receive Find without a workspace ID.
    const browserWorkspaceId = resolveWorkspaceId?.(browserTabId) || undefined
    const target: BrowserFindTarget = { browserPageId: browserTabId, browserWorkspaceId }
    renderer.send('ui:findInBrowserPage', target)
  } else if (
    (supportsAnnotations?.(browserTabId) ?? Boolean(resolveWorkspaceId?.(browserTabId))) &&
    keybindingMatchesAction('browser.annotateElement', input, process.platform, keybindings)
  ) {
    renderer.send('browser:grabModeToggle', browserTabId, 'annotate')
  } else if (keybindingMatchesAction('browser.back', input, process.platform, keybindings)) {
    // macOS side-button remaps can arrive as history keys instead of mouse events.
    renderer.send('ui:browserHistoryNavigate', { browserPageId: browserTabId, direction: 'back' })
  } else if (keybindingMatchesAction('browser.forward', input, process.platform, keybindings)) {
    renderer.send('ui:browserHistoryNavigate', {
      browserPageId: browserTabId,
      direction: 'forward'
    })
  } else if (keybindingMatchesAction('tab.close', input, process.platform, keybindings)) {
    if (isFloatingGuest) {
      renderer.send('ui:closeFloatingItem', { sourceId: browserTabId })
    } else {
      // Guest focus may leave active-tab state stale in splits; close by source ID.
      renderer.send('ui:closeActiveTab', { sourceId: browserTabId })
    }
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
  } else if (
    matchesGuestTabShortcut(
      input,
      process.platform,
      keybindings,
      isMobileEmulatorEnabled?.() ?? true
    )
  ) {
    // Why: replay into the renderer's own tab-shortcut handler so a page answers tab chords exactly as the rest of Orca does.
    const { key, code, alt, meta, control, shift, doubleTapModifier } = input
    const shortcut: BrowserPageTabShortcut = {
      key,
      code,
      alt,
      meta,
      control,
      shift,
      doubleTapModifier
    }
    renderer.send('ui:browserPageTabShortcut', shortcut)
  } else {
    return false
  }
  // Prevent the guest from also handling the forwarded chord.
  event.preventDefault()
  return true
}
