import type { BrowserWindow, WebContents } from 'electron'
import { extensionCanSeeUrl } from './extension-match-pattern'

export const TAB_ID_NONE = -1
export const WINDOW_ID_NONE = -1
export const WINDOW_ID_CURRENT = -2

/** What the tab registry knows about a tab beyond its WebContents. */
export type TabPlacement = { window: BrowserWindow; index: number; active: boolean }

/** A chrome.tabs.Tab. URL, title and icon only for extensions allowed to see the page. */
export function describeTab(
  tab: WebContents,
  placement: TabPlacement,
  extension: Electron.Extension | null
): Record<string, unknown> {
  const url = tab.getURL()
  const visible = extension === null || extensionCanSeeUrl(extension, url)
  const [width, height] = placement.window.isDestroyed()
    ? [0, 0]
    : placement.window.getContentSize()
  return {
    id: tab.id,
    index: placement.index,
    windowId: placement.window.id,
    active: placement.active,
    highlighted: placement.active,
    selected: placement.active,
    pinned: false,
    incognito: false,
    discarded: false,
    autoDiscardable: true,
    frozen: false,
    groupId: -1,
    status: tab.isLoading() ? 'loading' : 'complete',
    audible: tab.isCurrentlyAudible(),
    mutedInfo: { muted: tab.isAudioMuted() },
    width,
    height,
    ...(visible ? { url, title: tab.getTitle() } : {})
  }
}

/** A chrome.windows.Window; `tabs` only when populated. */
export function describeWindow(
  window: BrowserWindow,
  type: 'normal' | 'popup',
  tabs: Record<string, unknown>[] | null
): Record<string, unknown> {
  const bounds = window.getBounds()
  return {
    id: window.id,
    focused: window.isFocused(),
    top: bounds.y,
    left: bounds.x,
    width: bounds.width,
    height: bounds.height,
    incognito: false,
    alwaysOnTop: window.isAlwaysOnTop(),
    type,
    state: window.isMinimized()
      ? 'minimized'
      : window.isFullScreen()
        ? 'fullscreen'
        : window.isMaximized()
          ? 'maximized'
          : 'normal',
    ...(tabs ? { tabs } : {})
  }
}
