import { ORCA_BROWSER_BLANK_URL } from '../../shared/constants'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import { randomUUID } from 'node:crypto'
import { setExtensionTabHost } from './extensions/extension-tab-registry'
import { BrowserManagerEventForwarding } from './browser-manager-event-forwarding'

export abstract class BrowserManagerFinal extends BrowserManagerEventForwarding {
  constructor() {
    super()
    // Why here: only the renderer owns Orca's tab model, so extensions act on tabs through it.
    const pageOf = (tab: Electron.WebContents) => this.tabIdByWebContentsId.get(tab.id)
    setExtensionTabHost({
      open: (nextTo, url, active) => {
        const pageId = pageOf(nextTo)
        return pageId !== undefined && this.openLinkInOrcaTab(pageId, url, active)
      },
      close: (tab) => {
        const pageId = pageOf(tab)
        const renderer = pageId === undefined ? null : this.resolveRendererForBrowserTab(pageId)
        renderer?.send('browser:requestTabClose', {
          requestId: randomUUID(),
          tabId: pageId,
          worktreeId: pageId === undefined ? undefined : this.worktreeIdByTabId.get(pageId)
        })
      },
      activate: (tab) => {
        const pageId = pageOf(tab)
        const renderer = pageId === undefined ? null : this.resolveRendererForBrowserTab(pageId)
        renderer?.send('browser:activateView', {
          worktreeId: pageId === undefined ? undefined : this.worktreeIdByTabId.get(pageId),
          browserPageId: pageId
        })
      }
    })
  }

  protected openLinkInOrcaTab(browserTabId: string, rawUrl: string, activate?: boolean): boolean {
    const renderer = this.resolveRendererForBrowserTab(browserTabId)
    if (!renderer) {
      return false
    }
    const normalizedUrl = normalizeBrowserNavigationUrl(rawUrl)
    if (!normalizedUrl || normalizedUrl === ORCA_BROWSER_BLANK_URL) {
      return false
    }
    // Why: only the renderer owns Orca's worktree/tab model; main forwards a validated URL, never letting guest content mutate it.
    renderer.send('browser:open-link-in-orca-tab', {
      browserPageId: browserTabId,
      url: normalizedUrl,
      ...(activate === false ? { activate: false } : {})
    })
    return true
  }
}
