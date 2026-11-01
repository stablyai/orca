import { ORCA_BROWSER_BLANK_URL } from '../../shared/constants'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import { BrowserManagerEventForwarding } from './browser-manager-event-forwarding'

export abstract class BrowserManagerFinal extends BrowserManagerEventForwarding {
  protected openLinkInOrcaTab(browserTabId: string, rawUrl: string, activate?: boolean): boolean {
    const renderer = this.resolveRendererForBrowserTab(browserTabId)
    // Headless serve pages have no renderer tab model; the runtime opens their workspace's tabs.
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
      openOffscreen(normalizedUrl, activate !== false)
    }
    this.pageEvents.emit(browserTabId, { kind: 'tab', url: normalizedUrl })
    return true
  }

  /** A page with no workspace (orcad's Electron browser) has no tab list to open into. */
  private resolveOffscreenTabOpener(
    browserTabId: string
  ): ((url: string, activate: boolean) => void) | null {
    const opener = this.offscreenTabOpener
    const webContentsId = this.webContentsIdByTabId.get(browserTabId)
    const worktreeId = this.worktreeIdByTabId.get(browserTabId)
    if (
      !opener ||
      !worktreeId ||
      webContentsId === undefined ||
      !this.offscreenGuestIds.has(webContentsId)
    ) {
      return null
    }
    const profileId = this.sessionProfileIdByPageId.get(browserTabId) ?? null
    return (url, activate) =>
      opener({
        worktreeId,
        profileId,
        url,
        activate,
        pairedDeviceId: this.pageInputCredit.consume(browserTabId)
      })
  }
}
