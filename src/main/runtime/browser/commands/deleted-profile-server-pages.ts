import { browserManager } from '../../../browser/guest-lifecycle/manager/browser-manager'
import type { RuntimeBrowserTabClose } from '../tabs/browser-tab-close'
import type { RuntimeBrowserCommandHost } from './browser-command-contracts'

/** A window's tabs of a deleted profile load nowhere; a server's would stay in its wiped session or reopen in Default, so they close. */
export async function closeServerPagesInDeletedProfile(
  host: Pick<
    RuntimeBrowserCommandHost,
    'getOffscreenBrowserBackend' | 'getAvailableAuthoritativeWindowId' | 'serveBrowserTabs'
  >,
  close: Pick<RuntimeBrowserTabClose, 'browserTabClose'>,
  profileId: string
): Promise<void> {
  const offscreen = host.getOffscreenBrowserBackend()
  if (!offscreen || host.getAvailableAuthoritativeWindowId() !== null) {
    return
  }
  const pages = new Map<string, string | undefined>(
    (host.serveBrowserTabs?.pagesInProfile(profileId) ?? []).map((page) => [
      page.pageId,
      page.worktreeId
    ])
  )
  for (const pageId of offscreen.pageIdsInProfile?.(profileId) ?? []) {
    if (!pages.has(pageId)) {
      pages.set(pageId, browserManager.getWorktreeIdForTab(pageId))
    }
  }
  for (const [page, worktreeId] of pages) {
    await close
      .browserTabClose({ page, ...(worktreeId ? { worktree: `id:${worktreeId}` } : {}) })
      .catch((error) => {
        console.warn('[browser-profiles] Failed to close a page of a deleted profile', error)
      })
  }
}
