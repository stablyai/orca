import { browserManager } from '../../guest-lifecycle/manager/browser-manager'
import { isBrowserClientPageGuest } from '../../client-pages/lifecycle/browser-client-page-memory-registry'

/**
 * The key a page's panels are grouped by. Main has no workspace for a This-device page (its
 * server owns the tab), and such a page sits alone in its browser tab, so the page keys them.
 */
export function browserExtensionSidePanelWorkspaceForPage(browserPageId: string): string | null {
  const workspaceId = browserManager.getWorkspaceIdForPage(browserPageId)
  if (workspaceId) {
    return workspaceId
  }
  const guestId = browserManager.getGuestWebContentsId(browserPageId)
  return guestId !== null && isBrowserClientPageGuest(browserPageId, guestId) ? browserPageId : null
}
