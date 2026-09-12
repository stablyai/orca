import { ORCA_BROWSER_BLANK_URL } from '../../shared/constants'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import { BrowserManagerEventForwarding } from './browser-manager-event-forwarding'
import { randomUUID } from 'node:crypto'
import type { BrowserOpenLinkEvent } from '../../shared/browser-open-link-event'

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
    const worktreeId = this.worktreeIdByTabId.get(browserTabId)
    const childBrowserPageId = this.downloadCapture.hasPending(browserTabId)
      ? randomUUID()
      : undefined
    if (childBrowserPageId) {
      this.downloadCapture.inherit(browserTabId, childBrowserPageId, normalizedUrl)
    }
    renderer.send('browser:open-link-in-orca-tab', {
      browserPageId: browserTabId,
      url: normalizedUrl,
      ...(childBrowserPageId ? { childBrowserPageId } : {}),
      ...(worktreeId
        ? {
            owner: {
              worktreeId,
              workspaceId: this.workspaceIdByPageId.get(browserTabId),
              sessionProfileId: this.getSessionProfileIdForTab(browserTabId)
            }
          }
        : {}),
      ...(activate === false ? { activate: false } : {})
    } satisfies BrowserOpenLinkEvent)
    return true
  }
}
