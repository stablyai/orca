import type { BrowserPageZoomDirection } from '../../shared/browser-page-zoom'
import {
  isRecentTabSwitcherCommitRelease,
  matchesRecentTabSwitcherChord
} from '../../shared/window-shortcut-policy'
import {
  forwardGuestShortcutInput,
  type GuestShortcutForwardContext,
  type GuestShortcutInput
} from './browser-guest-shortcut-dispatch'

/**
 * Keys typed into an offscreen page arrive at the Orca window, not at a guest, so the window's key
 * routing asks here first. While a page holds keyboard focus its chords resolve exactly as a
 * focused <webview> guest's would: page zoom, history and reload act on that page, not on Orca.
 */
const contextByPageId = new Map<string, GuestShortcutForwardContext>()
const focusedPageByRenderer = new Map<number, string>()
const ctrlTabSwitchingRenderers = new Set<number>()

export function setOffscreenPageShortcutContext(
  browserPageId: string,
  context: GuestShortcutForwardContext | null
): void {
  if (context) {
    contextByPageId.set(browserPageId, context)
    return
  }
  contextByPageId.delete(browserPageId)
  for (const [rendererId, pageId] of focusedPageByRenderer) {
    if (pageId === browserPageId) {
      focusedPageByRenderer.delete(rendererId)
    }
  }
}

export function setOffscreenPageKeyboardFocus(
  rendererWebContentsId: number,
  browserPageId: string,
  focused: boolean
): void {
  if (focused) {
    focusedPageByRenderer.set(rendererWebContentsId, browserPageId)
  } else if (focusedPageByRenderer.get(rendererWebContentsId) === browserPageId) {
    focusedPageByRenderer.delete(rendererWebContentsId)
  }
}

export function clearOffscreenPageKeyboardFocus(rendererWebContentsId: number): void {
  focusedPageByRenderer.delete(rendererWebContentsId)
}

export function isOffscreenPageKeyboardFocused(rendererWebContentsId: number): boolean {
  return focusedContext(rendererWebContentsId) !== null
}

function focusedContext(rendererWebContentsId: number): GuestShortcutForwardContext | null {
  const pageId = focusedPageByRenderer.get(rendererWebContentsId)
  return pageId === undefined ? null : (contextByPageId.get(pageId) ?? null)
}

/** Returns true when the focused offscreen page claimed the key. */
export function routeOffscreenPageShortcut(
  rendererWebContentsId: number,
  event: Electron.Event,
  input: GuestShortcutInput & { type: string; shift?: boolean }
): boolean {
  const context = focusedContext(rendererWebContentsId)
  if (!context) {
    ctrlTabSwitchingRenderers.delete(rendererWebContentsId)
    return false
  }
  const renderer = context.resolveRenderer(context.browserTabId)
  // Why the recent-tab switcher here: it runs on keydown and commits on the modifier's keyup,
  // both of which a focused guest forwards; the page's keys never reach Orca's own handler.
  if (
    input.type === 'keyDown' &&
    matchesRecentTabSwitcherChord(input, process.platform, context.getKeybindings?.())
  ) {
    ctrlTabSwitchingRenderers.add(rendererWebContentsId)
    renderer?.send('ui:ctrlTabKeyDown', { shiftKey: input.shift === true })
    return true
  }
  if (
    ctrlTabSwitchingRenderers.has(rendererWebContentsId) &&
    isRecentTabSwitcherCommitRelease(input)
  ) {
    event.preventDefault()
    ctrlTabSwitchingRenderers.delete(rendererWebContentsId)
    renderer?.send('ui:ctrlTabKeyUp')
    return true
  }
  return input.type === 'keyDown' ? forwardGuestShortcutInput(context, event, input) : false
}

/** Native zoom commands (menu or layout-specific chords) zoom the focused page, not Orca. */
export function routeOffscreenPageZoomCommand(
  rendererWebContentsId: number,
  event: Electron.Event,
  direction: BrowserPageZoomDirection
): boolean {
  const context = focusedContext(rendererWebContentsId)
  if (!context) {
    return false
  }
  context.forwardBrowserPageZoom(event, direction)
  return true
}
