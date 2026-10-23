/**
 * Workspaces whose desktop pages an SSH host has driven through the bridge. Their pages lose the
 * auto-granted programmatic clipboard read for the rest of this run, so a host's script cannot
 * read the desktop clipboard through a page it controls. Typing and paste by the user still work.
 */
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
  // Why popup-aware: a popup a host-scripted page opened runs that host's code too.
  const pageId =
    webContentsId === undefined
      ? null
      : browserManager.getOwningTabIdForGuestWebContentsId(webContentsId)
  // Why fail closed: once a host drives pages, a guest with no known owner could be one of its.
  // An unowned extension page (popup, offscreen document) runs only the extension's own code.
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
