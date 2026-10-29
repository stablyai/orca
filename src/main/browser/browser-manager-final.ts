import { ORCA_BROWSER_BLANK_URL } from '../../shared/constants'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import { BrowserManagerEventForwarding } from './browser-manager-event-forwarding'

export abstract class BrowserManagerFinal extends BrowserManagerEventForwarding {
  protected openLinkInOrcaTab(browserTabId: string, rawUrl: string, activate?: boolean): boolean {
    const renderer = this.resolveRendererForBrowserTab(browserTabId)
    if (!renderer) {
      return false
    }
    const normalizedUrl = normalizeBrowserNavigationUrl(rawUrl)
    if (!normalizedUrl || normalizedUrl === ORCA_BROWSER_BLANK_URL) {
      return false
    }
    // The renderer owns Orca's tab model; forward the validated URL for materialization.
    renderer.send('browser:open-link-in-orca-tab', {
      browserPageId: browserTabId,
      url: normalizedUrl,
      ...(activate === false ? { activate: false } : {})
    })
    return true
  }
}
