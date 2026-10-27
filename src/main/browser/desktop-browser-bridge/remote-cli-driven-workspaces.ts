// SSH-driven workspaces lose programmatic clipboard reads until quit; user paste still works.
import { webContents } from 'electron'
import { parseChromeExtensionUrl } from '../../../shared/browser-extension-url'
import { browserManager } from '../browser-manager'

const drivenWorkspaceIds = new Set<string>()

export function markRemoteCliDrivenWorkspace(workspaceId: string): void {
  drivenWorkspaceIds.add(workspaceId)
}

export function isRemoteCliDrivenGuest(webContentsId: number | undefined): boolean {
  if (drivenWorkspaceIds.size === 0) {
    return false
  }
  // Include popups because they can run code from a host-driven opener.
  const pageId =
    webContentsId === undefined
      ? null
      : browserManager.getOwningTabIdForGuestWebContentsId(webContentsId)
  // Unknown guests may belong to a host-driven workspace; deny all but extension pages.
  if (!pageId) {
    return !isUnownedExtensionPage(webContentsId)
  }
  const workspaceId = browserManager.getWorktreeIdForTab(pageId)
  return workspaceId !== undefined && drivenWorkspaceIds.has(workspaceId)
}

function isUnownedExtensionPage(webContentsId: number | undefined): boolean {
  const contents = webContentsId === undefined ? undefined : webContents.fromId(webContentsId)
  return Boolean(contents && !contents.isDestroyed() && parseChromeExtensionUrl(contents.getURL()))
}

export function resetRemoteCliDrivenWorkspacesForTests(): void {
  drivenWorkspaceIds.clear()
}
