import { ORCA_BROWSER_BLANK_URL } from '../../shared/constants'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import { BrowserManagerEventForwarding } from './browser-manager-event-forwarding'

export abstract class BrowserManagerFinal extends BrowserManagerEventForwarding {
  protected openLinkInOrcaTab(browserTabId: string, rawUrl: string, activate?: boolean): boolean {
    const renderer = this.resolveRendererForBrowserTab(browserTabId)
    // Headless serve pages have no renderer tab model; the runtime opens their tabs.
    const openOffscreen = renderer ? null : this.resolveOffscreenTabOpener(browserTabId)
    if (!renderer && !openOffscreen) {
      return false
    }
    const normalizedUrl = normalizeBrowserNavigationUrl(rawUrl)
    if (!normalizedUrl || normalizedUrl === ORCA_BROWSER_BLANK_URL) {
      return false
    }
    if (renderer) {
      // The renderer owns Orca's tab model; forward the validated URL for materialization.
      renderer.send('browser:open-link-in-orca-tab', {
        browserPageId: browserTabId,
        url: normalizedUrl,
        ...(activate === false ? { activate: false } : {})
      })
    } else if (openOffscreen) {
      openOffscreen({
        openerPageId: browserTabId,
        worktreeId: this.worktreeIdByTabId.get(browserTabId) ?? null,
        profileId: this.sessionProfileIdByPageId.get(browserTabId) ?? null,
        url: normalizedUrl,
        activate: activate !== false
      })
    }
    this.pageEvents.emit(browserTabId, { kind: 'tab', url: normalizedUrl })
    return true
  }

  private resolveOffscreenTabOpener(browserTabId: string): typeof this.offscreenTabOpener {
    const webContentsId = this.webContentsIdByTabId.get(browserTabId)
    return webContentsId !== undefined && this.offscreenGuestIds.has(webContentsId)
      ? this.offscreenTabOpener
      : null
  }
}
