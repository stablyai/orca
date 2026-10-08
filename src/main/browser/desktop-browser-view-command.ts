import type { WebContents } from 'electron'
import type {
  DesktopBrowserViewCommand,
  DesktopBrowserViewCommandResult,
  DesktopBrowserViewState
} from '../../shared/desktop-browser-view-protocol'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import { normalizeBrowserPageZoomLevel } from '../../shared/browser-page-zoom'

export function navigateDesktopBrowserView(guest: WebContents, url: string): void {
  const normalized = normalizeBrowserNavigationUrl(url)
  if (!normalized) {
    throw new Error('Unsupported browser navigation URL')
  }
  // The existing guest policy reports load failures without destroying a usable tab.
  void guest.loadURL(normalized).catch(() => {})
}

export function executeDesktopBrowserViewCommand({
  guest,
  owner,
  command,
  inputAvailable,
  read
}: {
  guest: WebContents
  owner: WebContents
  command: DesktopBrowserViewCommand
  inputAvailable: boolean
  read: () => DesktopBrowserViewState
}): DesktopBrowserViewCommandResult {
  let findRequestId: number | undefined
  switch (command.kind) {
    case 'snapshot':
      break
    case 'navigate':
      navigateDesktopBrowserView(guest, command.url)
      break
    case 'back':
      if (guest.navigationHistory.canGoBack()) {
        guest.navigationHistory.goBack()
      }
      break
    case 'forward':
      if (guest.navigationHistory.canGoForward()) {
        guest.navigationHistory.goForward()
      }
      break
    case 'reload':
      if (command.ignoreCache) {
        guest.reloadIgnoringCache()
      } else {
        guest.reload()
      }
      break
    case 'zoom':
      guest.setZoomLevel(normalizeBrowserPageZoomLevel(command.level))
      break
    case 'stop':
      guest.stop()
      break
    case 'find':
      findRequestId = guest.findInPage(command.text, {
        forward: command.forward,
        findNext: command.findNext,
        matchCase: command.matchCase
      })
      break
    case 'stop-find':
      guest.stopFindInPage(command.action)
      break
    case 'focus':
      if (inputAvailable) {
        guest.focus()
      }
      break
    case 'blur':
      if (guest.isFocused() && !owner.isDestroyed()) {
        owner.focus()
      }
      break
  }
  return { state: read(), ...(findRequestId === undefined ? {} : { findRequestId }) }
}
