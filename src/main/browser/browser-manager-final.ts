import { ORCA_BROWSER_BLANK_URL } from '../../shared/constants'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import { BrowserManagerEventForwarding } from './browser-manager-event-forwarding'

type OpenLinkInTab = (url: string, activate: boolean) => void

export abstract class BrowserManagerFinal extends BrowserManagerEventForwarding {
  protected openLinkInOrcaTab(browserTabId: string, rawUrl: string, activate?: boolean): boolean {
    const renderer = this.resolveRendererForBrowserTab(browserTabId)
    const open: OpenLinkInTab | null = renderer
      ? // The renderer owns Orca's tab model; forward the validated URL for materialization.
        (url, activateTab) =>
          renderer.send('browser:open-link-in-orca-tab', {
            browserPageId: browserTabId,
            url,
            ...(activateTab ? {} : { activate: false })
          })
      : this.resolveOffscreenTabOpener(browserTabId)
    if (!open) {
      return false
    }
    const normalizedUrl = normalizeBrowserNavigationUrl(rawUrl)
    if (!normalizedUrl || normalizedUrl === ORCA_BROWSER_BLANK_URL) {
      return false
    }
    open(normalizedUrl, activate !== false)
    this.pageEvents.emit(browserTabId, { kind: 'tab', url: normalizedUrl })
    return true
  }

  /** Headless serve pages have no renderer tab model; the runtime opens tabs in their workspace. A page with no workspace (orcad's Electron browser) has no tab list to open into. */
  private resolveOffscreenTabOpener(browserTabId: string): OpenLinkInTab | null {
    const opener = this.offscreenTabOpener
    const webContentsId = this.webContentsIdByTabId.get(browserTabId)
    const guest =
      webContentsId === undefined ? null : this.getManagedBrowserGuestContext(webContentsId)
    const worktreeId = guest?.worktreeId
    if (!opener || guest?.owner !== 'offscreen' || !worktreeId) {
      return null
    }
    return (url, activate) =>
      opener({
        worktreeId,
        profileId: guest.sessionProfileId,
        url,
        activate,
        pairedDeviceId: this.pageInputCredit.consume(browserTabId)
      })
  }
}
