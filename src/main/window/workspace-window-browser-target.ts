import { webContents } from 'electron'
import { browserManager } from '../browser/browser-manager'
import { findLocalClientHostedBrowserPage } from '../browser/paired-runtime-browser-client-host-runtime'
import type { LocalWindowBrowserTarget } from '../runtime/local-window-browser-target'

export function resolveWorkspaceWindowBrowserTarget(
  runtimeId: string | null,
  localRuntimeId: string,
  params: { page?: string; worktree?: string }
): LocalWindowBrowserTarget | null {
  if (!runtimeId || !params.page) {
    return null
  }
  const guestId = browserManager.getGuestWebContentsId(params.page)
  const guest = guestId ? webContents.fromId(guestId) : null
  const context = guestId ? browserManager.getManagedBrowserGuestContext(guestId) : null
  const clientPage = findLocalClientHostedBrowserPage(runtimeId, params.page)
  if (clientPage && clientPage.state !== 'active') {
    return null
  }
  const worktreeId =
    clientPage?.workspaceId ?? (runtimeId === localRuntimeId ? context?.worktreeId : null)
  if (
    !guest ||
    guest.isDestroyed() ||
    context?.browserPageId !== params.page ||
    !worktreeId ||
    params.worktree !== `id:${worktreeId}`
  ) {
    return null
  }
  return { browserPageId: params.page, worktreeId, webContents: guest }
}
